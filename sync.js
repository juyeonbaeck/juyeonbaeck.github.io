// sync.js (최종 완성: AI 1.5-flash 적용 + 제목 기반 Slug)
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

const IMAGE_DIR = "assets/post-img/posts";

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

// [수정] AI 모델 변경 (gemini-1.5-flash)
async function getAiMetadata(content, title) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
      You are an SEO expert. 
      Task: Create a URL slug and a summary based on the content below.
      
      1. Slug: Translate the title "${title}" into English if needed. Use lowercase, hyphens only. No special chars. (e.g., "why-python-is-interpreted")
      2. Summary: 2-sentence summary in Korean.

      Output JSON ONLY:
      { "slug": "english-slug-here", "summary": "한국어 요약" }

      Content: ${content.substring(0, 1000)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
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
        console.log("🤖 AI가 Slug와 Summary 생성 시도 (Model: gemini-1.5-flash)...");
        const aiResult = await getAiMetadata(mdString, title);
        
        if (aiResult) {
            if (!slug) slug = aiResult.slug;
            if (!summary) summary = aiResult.summary;
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

      // [수정] AI 실패 시 "제목" 기반으로 Slug 생성 (숫자 X)
      if (!slug) {
        // 1. 한글/특수문자 제거 시도 (영어 제목일 경우)
        let tempSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        
        // 2. 만약 한글이라서 다 지워졌다면? -> 그냥 'post-날짜' (어쩔 수 없음)
        if (tempSlug.length < 2) {
             tempSlug = `post-${dateStr.replace(/-/g, '')}`;
        }
        
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
      const categoryProp = props.Category || props.Categories || props.카테고리;
      const category = categoryProp?.select?.name || "General";
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
      
      // 파일 저장 (Slug 적용)
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      
      if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 생성 완료: ${fileName}`);

      // 상태 업데이트
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