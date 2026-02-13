// sync.js (AI 수정 + 파일명 완벽 적용 + 오류 방지 버전)
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

// [핵심] AI 요약 및 Slug 생성 함수 (gemini-pro 사용)
async function getAiMetadata(content) {
  try {
    // 1.5-flash 대신 안정적인 'gemini-pro' 사용
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const prompt = `
      You are an SEO expert. Analyze the provided markdown content.
      
      Tasks:
      1. Create a URL slug in English (lowercase, hyphens only, remove special chars).
      2. Write a 2-sentence summary in Korean.

      Output Format (JSON ONLY):
      { "slug": "your-slug-here", "summary": "한국어 요약" }

      --- Content ---
      ${content.substring(0, 3000)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // JSON 파싱 (마크다운 기호 제거)
    const jsonString = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(`🤖 AI 생성 실패: ${error.message}`);
    return null;
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
      
      // 1. 기본 정보 추출 (안전하게)
      const titleProp = props.Name || props.이름 || props.제목;
      const title = titleProp?.title?.[0]?.plain_text || "No Title";
      const dateStr = props.Date?.date?.start || new Date().toISOString().split('T')[0];
      
      // 기존 Slug, Summary 확인
      let slug = props.Slug?.rich_text?.[0]?.plain_text || "";
      let summary = props.Summary?.rich_text?.[0]?.plain_text || "";

      console.log(`Processing: [${title}]`);

      // 2. 본문 변환
      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // 3. AI 자동 생성 (Slug나 Summary가 비어있을 때만)
      if (!slug || !summary) {
        console.log("🤖 AI가 내용을 분석 중입니다...");
        const aiResult = await getAiMetadata(mdString);
        
        if (aiResult) {
            if (!slug) slug = aiResult.slug;
            if (!summary) summary = aiResult.summary;
            
            console.log(`   👉 Generated Slug: ${slug}`);
            console.log(`   👉 Generated Summary: ${summary}`);

            // [중요] 생성된 값을 노션에 다시 저장 (그래야 나중에 봄)
            await notion.pages.update({
                page_id: pageId,
                properties: {
                    "Slug": { rich_text: [{ text: { content: slug } }] },
                    "Summary": { rich_text: [{ text: { content: summary } }] }
                }
            });
        }
      }

      // [비상 대책] AI가 실패해서 여전히 Slug가 없으면 -> '날짜-랜덤숫자'로 설정 (제목 사용 X)
      if (!slug) {
        slug = `${dateStr.replace(/-/g, '')}-${Math.floor(Math.random() * 1000)}`;
        console.warn(`⚠️ Slug 생성 실패. 임시 Slug 사용: ${slug}`);
      }

      // 4. 이미지 처리
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

      // 5. 카테고리 & 태그 처리 (에러 방지 코드 추가)
      const categoryProp = props.Category || props.Categories || props.카테고리;
      const category = categoryProp?.select?.name || "General"; // 없으면 General
      
      const tagsProp = props.Tags || props.태그;
      const tags = tagsProp?.multi_select ? tagsProp.multi_select.map(t => t.name) : [];

      // 6. 파일 저장
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
      
      // [핵심] 파일명에 Slug 적용!
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      
      if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 저장 완료: ${fileName}`);

      // 7. 상태 업데이트
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