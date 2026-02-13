// sync.js
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const yaml = require("js-yaml");

// 환경 변수 로드 (GitHub Actions에서는 자동으로 잡힘)
require("dotenv").config();

const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new Client({ auth: NOTION_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 이미지 저장 폴더 설정 (Chirpy 테마 기준)
const IMAGE_DIR = "assets/post-img"; 

// 이미지 다운로드 함수
async function downloadImage(url, filename) {
  const filepath = path.resolve(__dirname, IMAGE_DIR, filename);
  
  // 폴더가 없으면 생성
  if (!fs.existsSync(path.dirname(filepath))) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
  }

  const writer = fs.createWriteStream(filepath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function main() {
  console.log("🚀 노션 동기화 시작...");

  // 1. Published 상태인 글만 가져오기
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Status",
      status: { equals: "Published" },
    },
  });

  console.log(`📝 총 ${response.results.length}개의 글을 찾았습니다.`);

  for (const page of response.results) {
    const props = page.properties;
    
    // 2. 데이터 추출
    const title = props.Name.title[0]?.plain_text || "No Title";
    const dateStr = props.Date.date?.start || new Date().toISOString().split('T')[0];
    const slug = props.Slug.rich_text[0]?.plain_text || page.id;
    const summary = props.Summary.rich_text[0]?.plain_text || "";
    // 태그와 카테고리 처리
    const tags = props.Tags.multi_select ? props.Tags.multi_select.map(t => t.name) : [];
    const category = props.Category.select ? props.Category.select.name : "General";

    console.log(`Processing: ${title}`);

    // 3. 본문 변환 및 이미지 처리
    const mdBlocks = await n2m.pageToMarkdown(page.id);
    let mdString = n2m.toMarkdownString(mdBlocks).parent;

    // 이미지 링크 찾아서 다운로드 및 경로 교체
    // (정규식으로 마크다운 이미지 문법 ![alt](url) 찾기)
    const imageRegex = /!\[(.*?)\]\((.*?)\)/g;
    let match;
    let newMdString = mdString;

    // 이미지 처리 루프
    while ((match = imageRegex.exec(mdString)) !== null) {
      const altText = match[1];
      const imageUrl = match[2];
      
      // 노션 이미지 URL인 경우에만 다운로드
      if (imageUrl.includes('secure.notion-static.com') || imageUrl.includes('prod-files-secure')) {
        const fileExt = imageUrl.split('?')[0].split('.').pop() || 'png';
        const imageName = `${slug}-${Date.now()}.${fileExt}`; // 유니크한 파일명
        
        try {
          await downloadImage(imageUrl, imageName);
          // 마크다운 내 경로 변경 (/assets/post-img/파일명)
          const newPath = `/${IMAGE_DIR}/${imageName}`;
          newMdString = newMdString.replace(imageUrl, newPath);
          console.log(`  🖼 이미지 다운로드 완료: ${imageName}`);
        } catch (e) {
          console.error(`  ❌ 이미지 다운로드 실패: ${e.message}`);
        }
      }
    }

    // 4. Front Matter 생성 (Jekyll 양식)
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
      image: {
          path: "/assets/post-img/defaultImg.gif", // 대표 이미지가 있다면 여기서 처리 가능
          alt: "썸네일"
      }
    };

    const finalContent = `---\n${yaml.dump(frontMatter)}---\n\n${newMdString}`;

    // 5. 파일 저장
    const fileName = `${dateStr}-${slug}.md`;
    const filePath = path.join(__dirname, "_posts", fileName);
    
    // _posts 폴더가 없으면 생성
    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    fs.writeFileSync(filePath, finalContent);
    console.log(`✅ 저장 완료: ${fileName}`);
  }
}

main().catch(console.error);