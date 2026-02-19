// sync.js (확인된 모델: gemini-2.5-flash 적용 버전)
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

const IMAGE_DIR = "assets/img/posts"; // Chirpy 테마 표준 경로

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

// [핵심] 파워쉘에서 확인된 'gemini-2.5-flash' 모델 사용
async function getAiMetadata(content, title) {
  try {
    // 1.5 대신 2.5 사용 (사용자 계정에서 확인됨)
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const prompt = `
      You are an SEO expert.
      Task: Create a JSON object with a URL slug and a summary.

      1. "slug": Convert the title "${title}" into a concise English URL slug (lowercase, hyphens only, remove special chars).
      2. "summary": Write a 2-sentence summary in Korean.

      Output JSON ONLY:
      { "slug": "slug-result", "summary": "summary-result" }

      Content: ${content.substring(0, 1000)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // JSON 추출
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    console.error(`🤖 AI 생성 실패 (gemini-2.5-flash): ${error.message}`);
    
    // 만약 2.5도 안 되면, 아주 옛날 모델인 gemini-pro로 재시도 (비상용)
    try {
        console.log("🔄 비상용 모델(gemini-pro)로 재시도...");
        const backupModel = genAI.getGenerativeModel({ model: "gemini-pro" });
        const backupResult = await backupModel.generateContent(prompt);
        const backupText = backupResult.response.text();
        const jsonMatch = backupText.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
        return null;
    }
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
      
      const titleProp = props.Name || props.이름 || props.제목;
      const title = titleProp?.title?.[0]?.plain_text || "No Title";
      const dateStr = props.Date?.date?.start || new Date().toISOString().split('T')[0];
      
      let slug = props.Slug?.rich_text?.[0]?.plain_text || "";
      let summary = props.Summary?.rich_text?.[0]?.plain_text || "";

      console.log(`Processing: [${title}]`);

      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // [AI] Slug/Summary 생성
      if (!slug || !summary) {
        console.log("🤖 AI 요청 중 (Model: gemini-2.5-flash)...");
        const aiResult = await getAiMetadata(mdString, title);
        
        if (aiResult) {
            slug = aiResult.slug || slug;
            summary = aiResult.summary || summary;
            console.log(`   👉 AI 성공: Slug=[${slug}]`);
            
            // 노션 업데이트
            try {
                await notion.pages.update({
                    page_id: pageId,
                    properties: {
                        "Slug": { rich_text: [{ text: { content: slug } }] },
                        "Summary": { rich_text: [{ text: { content: summary } }] }
                    }
                });
            } catch (err) { console.error("   ⚠️ 노션 저장 실패:", err.message); }
        }
      }

      // [비상 대책]
      if (!slug) {
        let tempSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (tempSlug.length < 2) tempSlug = `post-${dateStr.replace(/-/g, '')}`;
        slug = tempSlug;
        console.warn(`⚠️ AI 실패. 제목 기반 Slug 사용: ${slug}`);
      }

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

      // Front Matter

      // 1. 카테고리 (Select 속성) 가져오기
      // 노션 속성 이름이 Category, Categories, 카테고리 중 하나면 인식함
      const categoryProp = props.Category || props.Categories || props.카테고리;
      const category = categoryProp?.select ? categoryProp.select.name : "General"; 
      // (값이 없으면 "General"로 자동 설정)

      // 2. 태그 (Multi-select 속성) 가져오기
      // 노션 속성 이름이 Tags, 태그 중 하나면 인식함
      const tagsProp = props.Tags || props.태그;
      const tags = tagsProp?.multi_select ? tagsProp.multi_select.map(t => t.name) : [];

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
      console.log(`✅ 파일 생성 완료: ${fileName}`);

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