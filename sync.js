// sync.js (최종 통합: 진단 모드 + 자동 모델 선택 + Chirpy 표준 경로)
const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const yaml = require("js-yaml");

require("dotenv").config();

// 환경 변수 로드
const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 클라이언트 초기화
const notion = new Client({ auth: NOTION_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// [이미지 경로] Chirpy 테마 표준 (assets/img/posts)
const IMAGE_DIR = "assets/img/posts";

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

// [핵심] 사용 가능한 AI 모델을 찾아내서 요청하는 진단형 함수
async function getAiMetadata(content, title) {
  try {
    console.log("🔍 [진단] 현재 API 키로 사용 가능한 모델 목록을 스캔합니다...");
    
    // 시도할 후보 모델 목록 (우선순위: 최신 -> 구형)
    const candidates = ["gemini-1.5-flash", "gemini-pro", "gemini-1.0-pro-latest"];
    let validModelName = null;
    
    // 1. 모델 생존 확인 (Dry Run)
    for (const name of candidates) {
        try {
            const model = genAI.getGenerativeModel({ model: name });
            // 아주 짧은 테스트 요청으로 모델이 살아있는지 찔러봅니다.
            const result = await model.generateContent("Test"); 
            await result.response; // 에러 안 나면 성공
            
            validModelName = name;
            console.log(`✅ [성공] '${name}' 모델이 반응했습니다! 이 모델을 사용합니다.`);
            break; // 작동하는 모델을 찾았으니 루프 종료
        } catch (e) {
            // 404 등의 에러가 나면 조용히 로그만 찍고 다음 후보로 넘어감
            console.warn(`❌ [실패] '${name}' 모델 접근 불가: ${e.message.split(' ')[0]}...`);
        }
    }

    if (!validModelName) {
        throw new Error("사용 가능한 모델을 하나도 찾지 못했습니다. Google Cloud Console에서 API 설정을 확인하세요.");
    }

    // 2. 찾은 모델로 진짜 작업 수행
    console.log(`🤖 AI 작업 시작 (Model: ${validModelName})...`);
    const model = genAI.getGenerativeModel({ model: validModelName });
    
    const prompt = `
      You are an SEO expert.
      Task: Create a JSON object with a URL slug and a summary.

      1. "slug": Convert the title "${title}" into a concise English URL slug (lowercase, hyphens only, remove special chars).
      2. "summary": Write a 2-sentence summary in Korean.

      Output JSON ONLY (no markdown blocks):
      { "slug": "slug-result", "summary": "summary-result" }

      Content: ${content.substring(0, 800)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // JSON 추출 (마크다운 ```json 제거)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    console.error(`🚨 [AI 진단 실패]`);
    console.error(`   👉 원인: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log("🚀 노션 동기화 시작...");

  try {
    // 1. 발행 대기 중인 글 가져오기
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
      
      // 데이터 추출
      const titleProp = props.Name || props.이름 || props.제목;
      const title = titleProp?.title?.[0]?.plain_text || "No Title";
      const dateStr = props.Date?.date?.start || new Date().toISOString().split('T')[0];
      
      let slug = props.Slug?.rich_text?.[0]?.plain_text || "";
      let summary = props.Summary?.rich_text?.[0]?.plain_text || "";

      console.log(`Processing: [${title}]`);

      // 본문 변환
      const mdBlocks = await n2m.pageToMarkdown(pageId);
      let mdString = n2m.toMarkdownString(mdBlocks).parent;

      // [AI] Slug/Summary가 비어있으면 자동 생성 시도
      if (!slug || !summary) {
        const aiResult = await getAiMetadata(mdString, title);
        
        if (aiResult) {
            slug = aiResult.slug || slug;
            summary = aiResult.summary || summary;
            
            console.log(`   👉 AI 생성 결과: Slug=[${slug}]`);
            
            // [중요] 노션에 다시 저장 (그래야 나중에 확인 가능)
            try {
                await notion.pages.update({
                    page_id: pageId,
                    properties: {
                        "Slug": { rich_text: [{ text: { content: slug } }] },
                        "Summary": { rich_text: [{ text: { content: summary } }] }
                    }
                });
                console.log(`   ✅ 노션 업데이트 완료`);
            } catch (err) {
                console.error(`   ⚠️ 노션 업데이트 실패: ${err.message}`);
            }
        }
      }

      // [비상 대책] AI 실패 시, 제목을 기반으로 Slug 생성 (파일명 깨짐 방지)
      if (!slug) {
        // 영문/숫자만 남기고 다 하이픈(-)으로 변경
        let tempSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // 만약 한글이라 다 지워졌으면 -> 'post-날짜' 형식 사용
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
          // 파일명에 Slug를 포함시켜 유니크하게 만듦
          const imageName = `${slug}-${Date.now()}.${fileExt}`;
          try {
            await downloadImage(imageUrl, imageName);
            newMdString = newMdString.replace(imageUrl, `/${IMAGE_DIR}/${imageName}`);
          } catch (e) {
            console.error(`❌ 이미지 다운로드 실패: ${e.message}`);
          }
        }
      }

      // Front Matter 생성 (Jekyll/Chirpy 형식)
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
      
      // 파일 저장 (Slug를 파일명으로)
      const fileName = `${dateStr}-${slug}.md`;
      const filePath = path.join(__dirname, "_posts", fileName);
      
      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      fs.writeFileSync(filePath, finalContent);
      console.log(`✅ 파일 생성 완료: ${fileName}`);

      // 노션 상태 업데이트 (Publish -> Published)
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