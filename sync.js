// sync.js (오류 수정 및 안정화 버전)
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const yaml = require("js-yaml");

require("dotenv").config();

const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const notion = new Client({ auth: NOTION_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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

// AI 요약 함수 (모델 변경: gemini-pro)
async function getAiMetadata(content) {
  try {
    // [수정] 가장 안정적인 'gemini-pro' 모델 사용
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const prompt = `
      You are an SEO expert. Analyze the markdown content.
      1. Slug: Concise English URL slug (lowercase, hyphens only).
      2. Summary: 2-sentence summary in Korean.
      Return ONLY JSON: { "slug": "...", "summary": "..." }
      
      Content: ${content.substring(0, 2000)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(`🤖 AI 생성 실패: ${error.message}`);
    return null; // 실패하면 null 반환
  }
}

async function main() {
  console.log("🚀 노션 동기화 시작...");

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
      
      // 1. 제목 안전하게 가져오기
      const titleProp = props.Name || props.이름 || props.제목;
      const title = titleProp?.title?.[0]?.plain_text || "No Title";
      const dateStr = props.Date?.date?.start || new Date().toISOString().split('T')[0];
      
      console.log(`Processing: [${title}]`);

      // 2. Slug, Summary 기존값 확인
      let slug = props.Slug?.rich_text?.[0]?.plain_text || "";
      let summary = props.Summary?.rich_text?.[0]?.plain_text || "";

      // 3. 본문 변환
      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // 4. AI 자동 생성 (비어있을 경우만)
      if (!slug || !summary) {
        console.log("🤖 AI가 메타데이터 생성 시도...");
        const aiResult = await getAiMetadata(mdString);
        
        if (aiResult) {
            if (!slug) slug = aiResult.slug;
            if (!summary) summary = aiResult.summary;
            
            // 노션 업데이트
            await notion.pages.update({
                page_id: pageId,
                properties: {
                    "Slug": { rich_text: [{ text: { content: slug } }] },
                    "Summary": { rich_text: [{ text: { content: summary } }] }
                }
            });
            console.log(`   👉 AI 생성 완료: ${slug}`);
        }
      }

      // [안전 장치] AI가 실패했거나 원래 비어있으면 기본값 설정
      if (!slug) slug = pageId; 

      // 5. 이미지 처리
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

      // 6. 카테고리 처리 (에러 났던 부분 수정!)
      // Category, Categories, 카테고리 중 하나라도 있으면 가져옴
      const categoryProp = props.Category || props.Categories || props.카테고리;
      const category = categoryProp?.select ? categoryProp.select.name : "General"; // 없으면 General

      // 태그 처리
      const tagsProp = props.Tags || props.태그;
      const tags = tagsProp?.multi_select ? tagsProp.multi_select.map(t => t.name) : [];

      // 7. 파일 저장
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
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      
      if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 저장 완료: ${fileName}`);

      // 8. 상태 업데이트
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