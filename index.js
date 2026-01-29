const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');
const zlib = require('zlib'); // 상단에 추가 필요

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = '';
const DART_API_KEY = '';
const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let isMonitoring = false;
let monitorTimer = null;
let targetChatId = null;
const sentSet = new Set();

/* ======================
    🔥 지능형 필터링 및 키워드
====================== */
const GOOD_REGEX = /단일판매|공급계약|무상증자|특허권|자기주식|제3자배정|양수도|투자판단|주요경영사항|기타\s*시장\s*안내|임상|FDA|승인|허가|기술이전|샌드박스|로봇|AI|탈모|신약/i;
const BAD_REGEX = /(주식처분|신탁계약|계획|예정|정정|자회사|검토|가능성|기대|준비중|추진)/i;
const SUPER_INVESTORS = /삼성|현대|기아|LG||SK|한화|네이버|NAVER|카카오|KAKAO|포스코/i;

const HOT_KEYWORDS = new RegExp([
    'FDA', 'EMA', 'PMDA', 'CSR', '보고서\\s*수령', '임상\\s*시험\\s*결과', '통계적\\s*유의성', '탑라인', 'Top-line', 
    '품목\\s*허가', '최종\\s*승인', '기술\\s*이전', '기술\\s*수출', '라이선스\\s*아웃', '신약\\s*허가', 'NDA', 'BLA',
    '협동\\s*로봇', '자율\\s*주행', 'AMR', 'AGV', '온디바이스\\s*AI', 'LLM','결과','임상','수출','이전','승인','L\\s*O'
].join('|'), 'i');

/* ======================
    🏷️ 호재 태그 생성
====================== */
function extractHotKeyword(title, detail) {
    if (/임상|FDA|CSR|승인|탑라인/.test(title + detail)) return '🧬 바이오/기술 호재';
    if (/로봇|AMR|AGV|감속기|협동/.test(detail + title)) return '🤖 로봇/자동화';
    if (/단일판매|공급계약/.test(title)) return '💰 공급계약';
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
    return currentTime >= 900 && currentTime <= 2140; // 테스트를 위해 종료시간 넉넉히 설정
}

/* ======================
    🔍 본문 추출 및 [중요] 정제 로직
====================== */


async function getDartDetail(rcpNo) {
    const apiUrl = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
    
    try {
        const res = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const buffer = Buffer.from(res.data);
        
        let content = "";

        // PK 시그니처 확인 (80, 75)
        if (buffer[0] === 80 && buffer[1] === 75) {
            try {
                // 방법 A: AdmZip 시도
                const zip = new AdmZip(buffer);
                content = zip.getEntries()[0].getData().toString('utf8');
            } catch (e) {
                // 방법 B: AdmZip 실패 시 강제 문자열 변환 후 정제 (최후의 수단)
                // 바이너리 데이터 사이의 한글/영문 텍스트만 추출
                content = buffer.toString('utf8', 0, buffer.length);
                console.log(` [주의] ${rcpNo} 압축 해제 실패, 강제 텍스트 변환 시도`);
            }
        } else {
            content = buffer.toString('utf8');
        }

        // 공통 정제 로직 (HTML/XML 태그 제거)
        let text = content
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") 
            .replace(/<[^>]*>?/g, " ")                     
            .replace(/&nbsp;/g, " ")                       
            .replace(/\s+/g, " ")                          
            .trim();

        // 만약 정제 후에도 이상한 바이너리 찌꺼기가 남았다면 한글/숫자/기호만 남김
        text = text.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9.\s%()\[\]:,-]/g, "");

        return text || "본문 내용 없음";

    } catch (e) {
        console.error(` [추출 실패] ${rcpNo}: ${e.message}`);
        return "본문 추출 실패";
    }
}

/* ======================
    🚀 페이징 처리가 추가된 통합 스캔 엔진
===================== */
async function scanDart(totalCount = 10, isTest = false, startDate = null, endDate = null) {
    if (!targetChatId) return;
    const logTime = moment().format('HH:mm:ss');

    if (!isTest && !isMarketOpen()) {
        console.log(`[${logTime}] [대기] 장 운영 시간 외 대기 중...`);
        return;
    }

    try {
        // 1. 페이지 수 계산 (예: 1000건 요청 시 100건씩 10페이지)
        const limitPerPage = 100;
        const totalPages = Math.ceil(totalCount / limitPerPage);
        let allList = [];

        console.log(`[${logTime}] [시작] 총 ${totalCount}건 데이터 수집 중 (${totalPages}개 페이지)...`);

        // 2. 페이지 루프 (DART API 반복 호출)
        for (let page = 1; page <= totalPages; page++) {
            const params = { 
                crtfc_key: DART_API_KEY, 
                page_count: limitPerPage,
                page_no: page 
            };
            if (startDate) params.bgn_de = startDate;
            if (endDate) params.end_de = endDate;

            const res = await axios.get(DART_LIST_URL, { params, timeout: 10000 });
            
            if (res.data.status === '000' && res.data.list) {
                allList = allList.concat(res.data.list);
            } else {
                break; // 데이터가 더 없으면 중단
            }
            
            // API 과부하 방지를 위한 미세 지연 (0.1초)
            await new Promise(r => setTimeout(r, 100));
        }

        // 3. 최신순이 아닌 과거순부터 처리하기 위해 반전 (DART는 기본 최신순)
        const list = allList.reverse();
        console.log(`[${logTime}] [분석] 총 ${list.length}건의 공시 필터링 시작`);

        // 4. 공시 분석 루프 (기존 로직과 동일)
        for (const item of list) {
            const { report_nm: title, corp_name: corp, rcept_no: rcpNo } = item;
            const key = `${corp}_${rcpNo}`;
            const currentTime = moment().format('HH:mm:ss');

            if (!isTest && sentSet.has(key)) continue;

            // 1차 필터링 로그 (요청하신 형식)
            if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) {
                console.log(` [제외] [${currentTime}][${corp}] ${title}`);
                continue;
            }

            const docDetail = await getDartDetail(rcpNo);
            let isPass = false;
            let extraInfo = "";

            // [수정된 로직 1] 수주/공급계약 비율 추출 정밀화
            if (title.includes("단일판매") || title.includes("공급계약")) {
                // 1. "매출액대비(%)" 바로 뒤에 오는 숫자(소수점 포함)를 정확히 타겟팅
                const ratioMatch = docDetail.match(/매출액\s*대비\s*\(?\s*%\s*\)?\s*([\d.]+)/i);
                
                if (ratioMatch) {
                    const ratio = parseFloat(ratioMatch[1]);
                    
                    // 2. 만약 추출된 숫자가 비정상적으로 크거나(예: 지분율 80), 
                    // 30% 이상인 경우만 통과 (1000% 미만 조건 포함)
                    if (ratio >= 80 && ratio < 1000) { 
                        isPass = true;
                        extraInfo = ratio >= 200 
                            ? `\n🔴🔴🔴 <b>[초강력 수주] 매출액 대비 ${ratio}%!</b>` 
                            : `\n🔴 <b>우량 수주: 매출액 대비 ${ratio}%</b>`;
                    }
                } else if (title.includes("기재정정")) {
                    // 비율을 못 찾더라도 기재정정 공시는 중요하므로 통과
                    isPass = true;
                    extraInfo = `\n🔄 <b>수주 내용 정정 공시 (기존 계약)</b>`;
                }
            }
            else if (title.includes("임상") || title.includes("탑라인") || HOT_KEYWORDS.test(title + docDetail)) {
                isPass = true;
                extraInfo = /결과|성공|승인|탑라인/.test(title + docDetail) ? `\n🔥 <b>[핵심 결과 발표]</b>` : `\n🧬 <b>[중요 바이오]</b>`;
            }            
            else if (title.includes("양수도") || title.includes("최대주주") || title.includes("제3자배정")) {
                isPass = true;
                const playerRegex = /(?:양수인|배정대상자)\s*[:\s-]*\s*([가-힣\w\s(株)\(\)]{2,})/i;
                const match = docDetail.match(playerRegex);
                let mainPlayer = match ? match[1].trim() : "본문 참조";
                mainPlayer = mainPlayer.split("회사와의")[0].split("(")[0].trim();
                extraInfo = SUPER_INVESTORS.test(mainPlayer) ? `\n💎 <b>[🔴🔴🔴특급 투자자: ${mainPlayer}]</b>` : `\n🤝 <b>[투자 유치: ${mainPlayer}]</b>`;
            }

            if (!isPass) {
                console.log(` [미달] [${currentTime}][${corp}] ${title}`);
                continue;
            }

            console.log(` [발송] [${currentTime}][${corp}] ${title}`);
            if (!isTest) sentSet.add(key);
            
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
            await bot.sendMessage(targetChatId,
                `🚨 <b>[DART 알림]</b>\n\n🏢 <b>기업명:</b> ${corp}\n📄 <b>공시제목:</b> ${title}\n${extraInfo}\n\n📝 <b>요약:</b>\n<pre>${docDetail.substring(0, 1000)}...</pre>\n\n🔗 <a href="${link}">원문 보기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        }
    } catch (e) { console.error(` [에러] ${e.message}`); }
}


/* ======================
    🤖 명령어 처리
====================== */
bot.onText(/\/on/, (msg) => {
    targetChatId = msg.chat.id;
    if (!isMonitoring) {
        isMonitoring = true;
        bot.sendMessage(targetChatId, "🚀 <b>지능형 모니터링 가동</b>\n(대기업 투자/수주 20%/바이오 분석)");
        monitorTimer = setInterval(() => scanDart(5, false), 5000);
    }
});

bot.onText(/\/off/, (msg) => {
    isMonitoring = false; clearInterval(monitorTimer);
    bot.sendMessage(msg.chat.id, "🛑 <b>모니터링 중지</b>");
});

bot.onText(/\/test100/, async (msg) => {
    targetChatId = msg.chat.id;
    
    // 1. 기간 설정: 오늘 하루가 아니라 최근 3일 정도로 넓혀야 1000건을 채울 수 있습니다.
    const end = moment().format('YYYYMMDD');
    const bgn = moment().subtract(3, 'days').format('YYYYMMDD'); 

    await bot.sendMessage(targetChatId, `📊 <b>대규모 시뮬레이션 시작</b>\n📅 기간: ${bgn} ~ ${end}\n🔍 대상: 최신 공시 1,000건`, { parse_mode: 'HTML' });

    try {
        // 2. 반드시 await를 붙여서 스캔이 끝날 때까지 기다려야 합니다.
        await scanDart(1000, true, bgn, end); 
        
        await bot.sendMessage(targetChatId, `✅ <b>시뮬레이션 완료!</b>\n필터링된 호재 공시를 확인하세요.`, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(e);
        await bot.sendMessage(targetChatId, `❌ 시뮬레이션 중 에러 발생`);
    }
});


/* ======================
    🧪 큐라클 임상 결과 정밀 분석 테스트 (/test_curacle)
====================== */
bot.onText(/\/test_curacle/, async (msg) => {
    const chatId = msg.chat.id;
    const curacleRcpNo = "20260120900209"; // 큐라클 임상 공시번호
    targetChatId = chatId;

    bot.sendMessage(chatId, `🧬 <b>[바이오 엔진 테스트] 큐라클 임상 결과 분석 중...</b>`, { parse_mode: 'HTML' });

    try {
        // 1. DART 본문 데이터 가져오기 (기존 getDartDetail 활용)
        const docDetail = await getDartDetail(curacleRcpNo);
        const title = "투자판단관련주요경영사항(임상시험결과보고서(CSR) 수령)";
        const corp = "큐라클";

        // 2. 바이오 로직 시뮬레이션
        let isPass = false;
        let extraInfo = "";
        let tag = extractHotKeyword(title, docDetail);

        // 바이오 핵심 키워드 검사 (성공/유의성 등)
        const isSuccess = /통계적\s*유의성|확보|달성|성공|탑라인|Top-line/.test(docDetail + title);
        
        if (title.includes("임상") || title.includes("CSR") || HOT_KEYWORDS.test(title + docDetail)) {
            isPass = true;
            if (isSuccess) {
                extraInfo = `\n🔥 <b>[초강력 호재] 임상 데이터 유의성 확보(성공)!</b>\n📈 <b>핵심:</b> 탑라인(Top-line) 결과 발표`;
            } else {
                extraInfo = `\n🧬 <b>[중요] 바이오 관련 공시 감지 (결과 확인 필요)</b>`;
            }
        }

        // 3. 결과 전송
        await bot.sendMessage(chatId,
            `🧪 <b>[임상 공시 테스트 결과]</b>\n\n` +
            `🏢 <b>기업명:</b> ${corp}\n` +
            `📄 <b>공시제목:</b> ${title}\n` +
            `${extraInfo}\n\n` +
            `📝 <b>데이터 샘플 (통계치):</b>\n<pre>${docDetail.substring(docDetail.indexOf("유의성") - 20, docDetail.indexOf("유의성") + 150)}</pre>\n\n` +
            `🏷️ <b>분류:</b> ${tag}\n` +
            `🔗 <a href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${curacleRcpNo}">공시 원문 보기</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
        );

    } catch (e) {
        bot.sendMessage(chatId, "❌ 큐라클 테스트 에러: " + e.message);
    }
});

console.log('🚀 DART 지능형 엔진 작동 중...');