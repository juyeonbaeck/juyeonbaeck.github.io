// sync.js (Gemini AI 탑재 버전)
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const { GoogleGenerativeAI } = require("@google/generative-ai"); // AI 추가
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const yaml = require("js-yaml");

require("dotenv").config();

const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // 환경변수 추가

const notion = new Client({ auth: NOTION_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY); // AI 초기화

const IMAGE_DIR = "assets/post-img";

// 이미지 다운로드 함수
async function downloadImage(url, filename) {
  const filepath = path.resolve(__dirname, IMAGE_DIR, filename);
  if (!fs.existsSync(path.dirname(filepath))) fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const writer = fs.createWriteStream(filepath);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// [핵심] AI에게 요약과 Slug 요청하는 함수
async function getAiMetadata(content) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
      You are an SEO expert and a professional technical writer.
      Analyze the following markdown content and generate a URL slug and a summary.

      1. **Slug**: Create a concise, English, URL-friendly slug (lowercase, hyphens only).
      2. **Summary**: Write a 2-sentence summary in Korean.

      Return ONLY a JSON object like this (no code blocks, no markdown):
      { "slug": "your-generated-slug", "summary": "여기에 한국어 요약 작성" }

      --- Content ---
      ${content.substring(0, 3000)} 
    `; 
    // (비용/속도를 위해 앞부분 3000자만 보냄)

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // JSON 파싱 (혹시 모를 마크다운 기호 제거)
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonString);

  } catch (error) {
    console.error("🤖 AI 생성 실패:", error.message);
    return null;
  }
}

async function main() {
  console.log("🚀 노션 동기화 시작 (Target Status: Publish)...");

  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "Status",
        status: { equals: "Publish" },
      },
    });

    if (response.results.length === 0) {
      console.log("💤 발행 대기 중인 글이 없습니다.");
      return;
    }

    console.log(`📝 처리할 글 ${response.results.length}개를 찾았습니다.`);

    for (const page of response.results) {
      const pageId = page.id;
      const props = page.properties;
      const title = props.Name.title[0]?.plain_text || "No Title";
      const dateStr = props.Date.date?.start || new Date().toISOString().split('T')[0];
      
      // 기존 값 확인
      let slug = props.Slug?.rich_text[0]?.plain_text || "";
      let summary = props.Summary?.rich_text[0]?.plain_text || "";

      console.log(`Processing: [${title}]`);

      // 본문 변환
      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // -------------------------------------------------------
      // [AI 기능] Slug나 Summary가 비어있으면 AI가 생성
      // -------------------------------------------------------
      if (!slug || !summary) {
        console.log("🤖 AI가 Slug와 Summary를 생성 중입니다...");
        const aiResult = await getAiMetadata(mdString);
        
        if (aiResult) {
            if (!slug) {
                slug = aiResult.slug;
                console.log(`   👉 Generated Slug: ${slug}`);
            }
            if (!summary) {
                summary = aiResult.summary;
                console.log(`   👉 Generated Summary: ${summary}`);
            }

            // [중요] 생성된 값을 노션에도 다시 저장해줍니다! (다음에 볼 수 있게)
            await notion.pages.update({
                page_id: pageId,
                properties: {
                    "Slug": { rich_text: [{ text: { content: slug } }] },
                    "Summary": { rich_text: [{ text: { content: summary } }] }
                }
            });
        }
      }
      // -------------------------------------------------------

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
          } catch (e) { console.error(`❌ 이미지 에러: ${e.message}`); }
        }
      }

      // Front Matter 생성
      const frontMatter = {
        title: title,
        date: `${dateStr} 00:00:00 +0900`,
        categories: [props.Category.select?.name || "General"],
        tags: props.Tags.multi_select ? props.Tags.multi_select.map(t => t.name) : [],
        pin: false,
        math: true,
        mermaid: true,
        toc: true,
        comments: true,
        summary: summary, // AI가 만든 요약 들어감
        image: { path: "/assets/post-img/defaultImg.gif", alt: "썸네일" }
      };

      const finalContent = `---\n${yaml.dump(frontMatter)}---\n\n${newMdString}`;
      
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 생성 완료: ${fileName}`);

      // 상태 업데이트 (Published)
      if (props.Status) {
        await notion.pages.update({
          page_id: pageId,
          properties: { "Status": { status: { name: "Published" } } }
        });
        console.log(`✨ 상태 변경 완료: Published`);
      }
    }
  } catch (error) {
    console.error("❌ 치명적 오류:", error);
  }
}

main();