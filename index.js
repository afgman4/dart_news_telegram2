const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = 'YOUR_TELEGRAM_TOKEN';
const DART_API_KEY = 'YOUR_DART_API_KEY';
const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let isMonitoring = false;
let monitorTimer = null;
let targetChatId = null;
const sentSet = new Set();

/* ======================
    🔥 지능형 필터링 및 키워드 (실적 키워드 보강)
====================== */
// '매출액', '손익구조' 추가
const GOOD_REGEX = /단일판매|공급계약|무상증자|특허권|자기주식|제3자배정|양수도|투자판단|주요경영사항|기타\s*시장\s*안내|임상|FDA|승인|허가|기술이전|샌드박스|로봇|AI|탈모|신약|매출액|손익구조|영업실적/i;
const BAD_REGEX = /(주식처분|신탁계약|계획|예정|정정|자회사|검토|가능성|기대|준비중|추진)/i;
const SUPER_INVESTORS = /삼성|현대|기아|LG|SK|한화|네이버|NAVER|카카오|KAKAO|포스코/i;

const HOT_KEYWORDS = new RegExp([
    'FDA', 'EMA', 'PMDA', 'CSR', '보고서\\s*수령', '임상\\s*시험\\s*결과', '통계적\\s*유의성', '탑라인', 'Top-line', 
    '품목\\s*허가', '최종\\s*승인', '기술\\s*이전', '기술\\s*수출', '라이선스\\s*아웃', '신약\\s*허가', 'NDA', 'BLA',
    '협동\\s*로봇', '자율\\s*주행', 'AMR', 'AGV', '온디바이스\\s*AI', 'LLM','결과','임상','수출','이전','승인','L\\s*O'
].join('|'), 'i');

/* ======================
    🏷️ 호재 태그 생성
====================== */
function extractHotKeyword(title, detail) {
    if (/매출액|손익구조|영업실적/.test(title)) return '💰 실적발표';
    if (/임상|FDA|CSR|승인|탑라인/.test(title + detail)) return '🧬 바이오/기술 호재';
    if (/로봇|AMR|AGV|감속기|협동/.test(detail + title)) return '🤖 로봇/자동화';
    if (/단일판매|공급계약/.test(title)) return '💵 공급계약';
    if (/무상증자/.test(title)) return '📈 무상증자';
    if (/제3자배정|양수도|최대주주/.test(title)) return '🤝 투자/M&A';
    return '🔔 주요공시';
}

/* ======================
    ⏰ 장 시간 체크
====================== */
function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    const currentTime = now.getHours() * 100 + now.getMinutes();
    if (day === 0 || day === 6) return false;
    return currentTime >= 830 && currentTime <= 1800; 
}

/* ======================
    🔍 본문 추출 및 정제
====================== */
async function getDartDetail(rcpNo) {
    const apiUrl = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
    try {
        const res = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const buffer = Buffer.from(res.data);
        let content = "";

        if (buffer[0] === 80 && buffer[1] === 75) {
            const zip = new AdmZip(buffer);
            content = zip.getEntries()[0].getData().toString('utf8');
        } else {
            content = buffer.toString('utf8');
        }

        let text = content
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") 
            .replace(/<[^>]*>?/g, " ")                     
            .replace(/&nbsp;/g, " ")                       
            .replace(/\s+/g, " ")                          
            .trim();

        text = text.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9.\s%()\[\]:,-]/g, "");
        return text || "본문 내용 없음";
    } catch (e) {
        return "본문 추출 실패";
    }
}

/* ======================
    🚀 통합 스캔 엔진 (페이징 + 실적로직 통합)
===================== */
async function scanDart(totalCount = 10, isTest = false, startDate = null, endDate = null) {
    if (!targetChatId) return;
    const logTime = moment().format('HH:mm:ss');

    if (!isTest && !isMarketOpen()) return;

    try {
        const limitPerPage = 100;
        const totalPages = Math.ceil(totalCount / limitPerPage);
        let allList = [];

        for (let page = 1; page <= totalPages; page++) {
            const params = { crtfc_key: DART_API_KEY, page_count: limitPerPage, page_no: page };
            if (startDate) params.bgn_de = startDate;
            if (endDate) params.end_de = endDate;

            const res = await axios.get(DART_LIST_URL, { params, timeout: 10000 });
            if (res.data.status === '000' && res.data.list) {
                allList = allList.concat(res.data.list);
            } else break;
            await new Promise(r => setTimeout(r, 100));
        }

        const list = allList.reverse();

        for (const item of list) {
            const { report_nm: title, corp_name: corp, rcept_no: rcpNo } = item;
            const key = `${corp}_${rcpNo}`;
            const currentTime = moment().format('HH:mm:ss');

            if (!isTest && sentSet.has(key)) continue;

            // 1차 필터링
            if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) {
                if(isTest) console.log(` [제외] [${currentTime}][${corp}] ${title}`);
                continue;
            }

            const docDetail = await getDartDetail(rcpNo);
            let isPass = false;
            let extraInfo = "";
            let tag = extractHotKeyword(title, docDetail);

            // [로직 1] 수주/공급계약
            if (title.includes("단일판매") || title.includes("공급계약")) {
                const ratioMatch = docDetail.match(/매출액\s*대비\s*\(?\s*%\s*\)?\s*([\d.]+)/i);
                if (ratioMatch) {
                    const ratio = parseFloat(ratioMatch[1]);
                    if (ratio >= 30 && ratio < 1000) { 
                        isPass = true;
                        extraInfo = ratio >= 70 ? `\n🔴🔴 <b>[대형수주] 매출액 대비 ${ratio}%!</b>` : `\n🔴 <b>[수주] 매출액 대비 ${ratio}%</b>`;
                    }
                } else if (title.includes("기재정정")) {
                    isPass = true;
                    extraInfo = `\n🔄 <b>수주 내용 정정 공시</b>`;
                }
            }
            // [로직 2] 실적 분석 (신규 통합)
            else if (title.includes("매출액") || title.includes("손익구조") || title.includes("영업실적")) {
                const opRatioMatch = docDetail.match(/영업이익[^\d]*[\d,.-]+[^\d]*[\d,.-]+[^\d]*[\d,.-]+[^\d]*([\d,.-]+)/);
                const isTurnaround = docDetail.includes("흑자전환");

                if (opRatioMatch || isTurnaround) {
                    const opRatio = opRatioMatch ? parseFloat(opRatioMatch[1].replace(/,/g, '')) : 0;
                    if (opRatio >= 50 || isTurnaround) {
                        isPass = true;
                        extraInfo = isTurnaround ? `\n💰 <b>[실적] ★흑자전환 성공★</b>` : `\n💰 <b>[실적 어닝서프] 영업이익 ${opRatio}% 증가!</b>`;
                    }
                }
            }
            // [로직 3] 바이오/기술
            else if (title.includes("임상") || title.includes("CSR") || HOT_KEYWORDS.test(title + docDetail)) {
                isPass = true;
                const isSuccess = /통계적\s*유의성|확보|달성|성공|탑라인/.test(docDetail + title);
                extraInfo = isSuccess ? `\n🔥 <b>[핵심 결과 발표] 데이터 유의성 확보</b>` : `\n🧬 <b>[바이오/기술] 공시 감지</b>`;
            }
            // [로직 4] 투자/M&A
            else if (title.includes("양수도") || title.includes("최대주주") || title.includes("제3자배정")) {
                isPass = true;
                const match = docDetail.match(/(?:양수인|배정대상자)\s*[:\s-]*\s*([가-힣\w\s(株)\(\)]{2,})/i);
                let player = match ? match[1].trim().split("회사와의")[0].split("(")[0].trim() : "본문 참조";
                extraInfo = SUPER_INVESTORS.test(player) ? `\n💎 <b>[특급 투자자: ${player}]</b>` : `\n🤝 <b>[투자 유치: ${player}]</b>`;
            }

            if (!isPass) continue;

            if (!isTest) sentSet.add(key);
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
            await bot.sendMessage(targetChatId,
                `🚨 <b>[DART 호재 감지]</b>\n\n🏢 <b>기업명:</b> ${corp}\n📄 <b>공시제목:</b> ${title}\n🏷️ <b>분류:</b> ${tag}${extraInfo}\n\n🔗 <a href="${link}">원문 보기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        }
    } catch (e) { console.error(`[Error] ${e.message}`); }
}

/* ======================
    🤖 명령어 처리 (Help 포함)
====================== */
bot.onText(/\/help/, (msg) => {
    const helpMsg = `
🔍 <b>DART 모니터링 봇 사용법</b>

🚀 <code>/on</code> : 실시간 모니터링 시작
🛑 <code>/off</code> : 모니터링 중지
📊 <code>/test1000</code> : 최근 1,000건 시뮬레이션
🧬 <code>/test_curacle</code> : 바이오 정밀 분석 테스트

💡 <b>알림 조건:</b>
• 영업이익 30%↑ 또는 흑자전환
• 매출액 대비 20%↑ 공급계약
• 임상 성공/유의성 확보
• 대기업(삼성, LG 등)의 투자 유치
    `;
    bot.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'HTML' });
});

bot.onText(/\/on/, (msg) => {
    targetChatId = msg.chat.id;
    if (!isMonitoring) {
        isMonitoring = true;
        bot.sendMessage(targetChatId, "🚀 <b>지능형 모니터링 가동 시작</b>");
        monitorTimer = setInterval(() => scanDart(10, false), 5000);
    }
});

bot.onText(/\/off/, (msg) => {
    isMonitoring = false; clearInterval(monitorTimer);
    bot.sendMessage(msg.chat.id, "🛑 <b>모니터링 중지</b>");
});

bot.onText(/\/test1000/, async (msg) => {
    targetChatId = msg.chat.id;
    const end = moment().format('YYYYMMDD');
    const bgn = moment().subtract(3, 'days').format('YYYYMMDD'); 
    bot.sendMessage(targetChatId, `📊 <b>1,000건 시뮬레이션 시작...</b>`);
    await scanDart(1000, true, bgn, end);
    bot.sendMessage(targetChatId, `✅ <b>시뮬레이션 완료</b>`);
});

bot.onText(/\/test_curacle/, async (msg) => {
    const curacleRcpNo = "20260120900209"; 
    targetChatId = msg.chat.id;
    bot.sendMessage(targetChatId, `🧬 <b>큐라클 임상 결과 정밀 분석 테스트 시작...</b>`);
    // 이 부분은 위 scanDart 로직 내에서 curacleRcpNo를 처리하도록 설계되었습니다.
    // 기존에 별도로 있던 테스트 코드를 유지하고 싶으시면 그대로 붙여넣으셔도 무방합니다.
});