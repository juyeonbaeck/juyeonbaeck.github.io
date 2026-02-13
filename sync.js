// sync.js
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const yaml = require("js-yaml");

// 환경 변수 로드
require("dotenv").config();

const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 이미지 저장 폴더
const IMAGE_DIR = "assets/post-img";

// 이미지 다운로드 함수
async function downloadImage(url, filename) {
  const filepath = path.resolve(__dirname, IMAGE_DIR, filename);
  if (!fs.existsSync(path.dirname(filepath))) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
  }
  const writer = fs.createWriteStream(filepath);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function main() {
  console.log("🚀 노션 동기화 시작 (Target Status: Publish)...");

  try {
    // [변경점 1] Status가 'Publish'인 글만 가져옵니다.
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "Status",
        status: { equals: "Publish" }, 
      },
    });

    console.log(`📝 발행 대기 중인 글 ${response.results.length}개를 찾았습니다.`);

    for (const page of response.results) {
      const pageId = page.id;
      const props = page.properties;
      
      // 데이터 추출
      const title = props.Name.title[0]?.plain_text || "No Title";
      const dateStr = props.Date.date?.start || new Date().toISOString().split('T')[0];
      const slug = props.Slug.rich_text[0]?.plain_text || pageId;
      const summary = props.Summary.rich_text[0]?.plain_text || "";
      const tags = props.Tags.multi_select ? props.Tags.multi_select.map(t => t.name) : [];
      const category = props.Category.select ? props.Category.select.name : "General";

      console.log(`Processing: ${title}`);

      // 본문 변환
      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // 이미지 처리
      const imageRegex = /!\[(.*?)\]\((.*?)\)/g;
      let match;
      let newMdString = mdString;

      while ((match = imageRegex.exec(mdString)) !== null) {
        const imageUrl = match[2];
        if (imageUrl.includes('secure.notion-static.com') || imageUrl.includes('prod-files-secure')) {
          const fileExt = imageUrl.split('?')[0].split('.').pop() || 'png';
          const imageName = `${slug}-${Date.now()}.${fileExt}`;
          try {
            await downloadImage(imageUrl, imageName);
            newMdString = newMdString.replace(imageUrl, `/${IMAGE_DIR}/${imageName}`);
          } catch (e) {
            console.error(`  ❌ 이미지 실패: ${e.message}`);
          }
        }
      }

      // Front Matter 생성
      const frontMatter = {
        title: title,
        date: `${dateStr} 00:00:00 +0900`,
        categories: [category],
        tags: tags,
        pin: false,
        math: true,
        mermaid: true,
        toc: true,
        comments: true,
        summary: summary,
        image: { path: "/assets/post-img/defaultImg.gif", alt: "썸네일" }
      };

      const finalContent = `---\n${yaml.dump(frontMatter)}---\n\n${newMdString}`;
      
      // 파일 저장
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 생성 완료: ${fileName}`);

      // [변경점 2] 노션 상태 업데이트 (Publish -> Published)
      await notion.pages.update({
        page_id: pageId,
        properties: {
          "Status": {
            status: { name: "Published" }
          }
        }
      });
      console.log(`✨ 상태 변경 완료: Published`);
    }
  } catch (error) {
    console.error("❌ 오류 발생:", error);
  }
}

main();