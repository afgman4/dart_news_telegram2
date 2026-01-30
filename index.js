const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio'); // <--- 이 줄을 꼭 추가하세요!

/* ======================
    🔑 기본 설정 (반드시 본인 것으로 변경)
====================== */
const TELEGRAM_TOKEN = '';
const DART_API_KEY = '';
const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let isMonitoring = false;
let monitorTimer = null;
let targetChatId = null;
let lastMarketStatus = true; // 장 상태 변화 감지용
const sentSet = new Set();

/* ======================
    🔥 지능형 필터링 및 키워드
====================== */
const GOOD_REGEX = /단일판매|공급계약|무상증자|특허권|제3자배정|양수도|투자판단|주요경영사항|기타\s*시장\s*안내|임상|FDA|승인|허가|기술이전|샌드박스|로봇|AI|탈모|신약|매출액|손익구조|영업실적/i;
const BAD_REGEX = /(주식처분|신탁계약|계획|예정|정정|정지|상장적격성|최대주주의의무보유관련|해제|자회사|자본잠식|합병등종료보고서|기업심사위원회|검토|가능성|기대|증권발행결과|준비중|추진)/i;
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
    🔍 본문 추출 및 정제 (ZIP 지원)
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
    📊 실적 HTML 파싱 함수
====================== */
async function getEarningsFromMainPage(rcpNo) {
    try {
        const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
        
        const response = await axios.get(url, { 
            responseType: 'arraybuffer', 
            timeout: 15000 
        });

        const zip = new AdmZip(Buffer.from(response.data));
        const zipEntries = zip.getEntries();
        let htmlContent = zipEntries[0].getData().toString('utf8');
        
        const $ = cheerio.load(htmlContent);
        let revenue = null, op = null, net = null;

        const formatToEok = (valStr) => {
            if (!valStr || valStr.trim() === '-') return "0억원";
            const num = parseFloat(valStr.replace(/,/g, ''));
            if (isNaN(num)) return valStr;
            const eok = (num / 100000000).toFixed(1); 
            return `${eok}억원`;
        };

        // 1. 모든 테이블을 순회
        $('table').each((_, table) => {
            // 2. 해당 테이블 내의 모든 tr(행)을 찾음
            const rows = $(table).find('tr'); 
            
            rows.each((__, tr) => {
                const tds = $(tr).find('td');
                
                // HTML 구조상 colspan="2"가 첫 번째 td이므로 
                // 전체 td 개수는 6개(또는 5개 이상)입니다.
                if (tds.length >= 5) {
                    const title = $(tds[0]).text().replace(/\s/g, '');
                    
                    // 인덱스 맵핑 (HTML 기준):
                    // tds[0]: 항목명 (- 영업이익)
                    // tds[1]: 당기금액
                    // tds[2]: 전기금액
                    // tds[3]: 증감금액 (8,841,391,689)
                    // tds[4]: 증감비율 (86.3)

                    const changeAmountRaw = $(tds[3]).text().trim();
                    const ratioRaw = $(tds[4]).text().trim();

                    if (changeAmountRaw && changeAmountRaw !== '-') {
                        const amountEok = formatToEok(changeAmountRaw);
                        const resultText = `${amountEok} (${ratioRaw}%)`;

                        if (title.includes('매출액')) revenue = resultText;
                        else if (title.includes('영업이익')) op = resultText;
                        else if (title.includes('당기순이익')) net = resultText;
                    }
                }
            });

            // 값을 하나라도 찾았다면 더 이상 다른 테이블을 뒤지지 않고 종료
            if (revenue || op || net) return false; 
        });

        return { revenue, op, net };
    } catch (e) {
        console.error(`[API 본문추출 실패] rcpNo: ${rcpNo}, Error: ${e.message}`);
        return { revenue: 'N/A', op: 'N/A', net: 'N/A' };
    }
}


async function getBioNewFromOpenDart(rcpNo) {
    
    // 1. OpenDART 본문 API 호출 (결과는 ZIP 파일 바이너리)
    const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
    
    const response = await axios.get(url, { 
        responseType: 'arraybuffer', // 바이너리 데이터로 받기
        timeout: 15000 
    });

    // 2. ZIP 압축 해제
    const zip = new AdmZip(Buffer.from(response.data));
    const zipEntries = zip.getEntries();
    
    // 첫 번째 엔트리가 보통 메인 HTML 문서입니다.
    let htmlContent = zipEntries[0].getData().toString('utf8');
        
    const $ = cheerio.load(htmlContent);
    let clinicalResult = "";

    // 바이오 임상 결과값 섹션 타겟팅
    $('tr').each((_, tr) => {
        const tds = $(tr).find('td');
        // '결과값' 혹은 '시험결과'라는 단어가 포함된 행을 찾음
        const rowTitle = $(tds[0]).text().replace(/\s/g, '');
        const nextTitle = $(tds[1]) ? $(tds[1]).text().replace(/\s/g, '') : "";

        if (rowTitle.includes("결과값") || nextTitle.includes("결과값")) {
            clinicalResult = $(tds).last().text().trim();
            return false; // 찾으면 루프 종료
        }
    });

    // 만약 표 구조에서 못 찾았다면 '시험결과' 섹션 이후의 텍스트를 탐색
    if (!clinicalResult) {
        clinicalResult = $("span:contains('결과값')").parent().next().text().trim() || 
                         $("td:contains('결과값')").next().text().trim();
    }

    // 핵심 문구 요약 (중대한 이상반응 여부 등)
    let summary = "";
    if (clinicalResult) {
        const lines = clinicalResult.split('\n');
        // "보고되지 않았습니다", "유의미한 변화", "확보" 등의 핵심 문장이 포함된 라인만 필터링
        const keyLines = lines.filter(line => 
            /중대한 이상반응|SAE|이상사례|관찰되지 않았습니다|유의적|성공|뒷받침/.test(line)
        );
        summary = keyLines.length > 0 ? keyLines.join('\n').trim() : clinicalResult.substring(0, 200);
    }

    return { 
        // ... 기존 실적 데이터 ...
        clinicalResult: summary 
    };
}


/* ======================
    ⏰ 장 시간 체크 함수
====================== */
function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    const currentTime = now.getHours() * 100 + now.getMinutes();

    // 토요일(6), 일요일(0)은 장이 열리지 않음
    if (day === 0 || day === 6) return false;

    // 한국 시간 기준 07:50 ~ 20:10 (시간외 거래 포함)
    return currentTime >= 750 && currentTime <= 2010;
}
/* ======================
    🚀 통합 스캔 엔진 (오류 수정 및 로직 최적화)
===================== */
async function scanDart(totalCount = 10, isTest = false, targetDate = null) {
    if (!targetChatId) return;

    // 장 시간 체크 (테스트 모드가 아닐 때만)
    if (!isTest && !isMarketOpen()) {
        if (lastMarketStatus === true) { // 장이 열려있다가 닫힌 직후 한 번만 알림
            const timeNow = moment().format('HH:mm:ss');
            console.log(`[${timeNow}] 장시간 종료로 스캔 건너뜀`);
            bot.sendMessage(targetChatId, `😴 <b>현재 장 시간이 아닙니다.</b>\n(08:30 ~ 20:30 외 시간에는 데이터 추출을 중단합니다.)`);
            lastMarketStatus = false;
        }
        return;
    }
    lastMarketStatus = true; // 장 시간 내라면 상태 초기화


    const dateStr = targetDate || moment().format('YYYYMMDD');
    const limitPerPage = 100;
    const totalPages = Math.ceil(totalCount / limitPerPage);

    for (let page = 1; page <= totalPages; page++) {
        try {
            const params = {
                crtfc_key: DART_API_KEY,
                page_count: limitPerPage,
                page_no: page,
                bgn_de: dateStr,
                end_de: dateStr
            };

            const res = await axios.get(DART_LIST_URL, { params, timeout: 15000 });
            if (!res.data.list || res.data.list.length === 0) break;

            const list = isTest ? res.data.list : res.data.list.reverse();

            for (const item of list) {
                // 1. 변수명 통일 (title, corp, rcpNo 사용)
                const { report_nm: title, corp_name: corp, rcept_no: rcpNo } = item;
                const key = `${corp}_${rcpNo}`;

                const timeNow = moment().format('HH:mm:ss');

                console.log(`[${timeNow}] [스캔중] ${corp} - ${title}`);

                if (!isTest && sentSet.has(key)) continue;

                // 2. 1차 제목 필터링
                if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) continue;

                let isPass = false;
                let extraInfo = "";
                let tag = "";

                /* -------------------------------------------
                   [분기 1] 실적 공시 처리
                ------------------------------------------- */
                if (/매출액|손익구조|영업실적/.test(title)) {
                    if (isMarketOpen() && !isTest) continue;

                    // 1. 괄호 안의 비율(%) 숫자만 추출하는 함수
                    const getRatio = (str) => {
                        if (!str) return 0;
                        // 괄호 ( ) 안의 내용만 추출
                        const match = str.match(/\(([^)]+)\)/);
                        if (!match) return 0;
                        
                        // 숫자, 마이너스(-), 소수점(.) 외에 % 등 모든 문자 제거
                        const cleaned = match[1].replace(/[^0-9.-]/g, '');
                        return parseFloat(cleaned) || 0;
                    };

                    // 헬퍼 함수: "149.5억원 (86.3%)" 문자열에서 숫자만 뽑아내는 기능
                    const getNum = (str) => {
                        if (!str) return 0;
                        // 숫자, 마이너스 부호, 소수점만 남기고 제거
                        const cleaned = str.split('억원')[0].replace(/[^0-9.-]/g, '');
                        return parseFloat(cleaned) || 0;
                    };

                    
                    const e = await getEarningsFromMainPage(rcpNo);

                    // 모든 데이터가 없으면 스킵
                    if (!e.revenue && !e.op && !e.net) continue;

                    const opRatio = getRatio(e.op);   // 영업이익 증감률 (%)
                    const netRatio = getRatio(e.net); // 당기순이익 증감률 (%)
                    const opVal = getNum(e.op);       // 영업이익 증감액 (억원)

                    console.log(`[실적분석] 매출: ${e.revenue}, 증감액: ${opVal}, 증감률: ${opRatio}`);
                    // 2. 영업이익 증감률이 마이너스(-)이거나 데이터가 없으면 스킵
                    // 예: " ( -77.3%)" -> -77.3 이므로 0보다 작아서 스킵됨
                    // 단, 70% 미만이면서 영업이익이 100억원 미만인 경우도 스킵
                    if (!e.op || opRatio < 70) {                        
                        console.log(`[스킵] 영업이익 100미만 및 증감률 ${opRatio}%`);
                        continue;                         
                    }
                    
                    if(!e.op || opRatio >= 70) {
                        if (opVal < 100) {
                            console.log(`[스킵] 영업이익 100미만 및 증감률 ${opRatio}%`);
                            continue;
                        }
                    }                    
                    

                    // 3. 당기순이익 증감률이 마이너스(-)이거나 데이터가 없으면 스킵
                    if (!e.net || netRatio < 0) {
                        console.log(`[스킵] 당기순이익 감소 또는 적자: ${netRatio}%`);
                        continue;
                    }

                    await bot.sendMessage(targetChatId, `
🚨 <b>[DART 💰 실적발표]</b>

🏢 <b>${corp}</b>
📄 ${title}
📄 전송시간: ${timeNow}
📈 매출액: <b>${e.revenue ?? '-'}%</b>
📉 영업이익: <b>${e.op ?? '-'}%</b>
📉 순이익: <b>${e.net ?? '-'}%</b>

🔗 <a href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}">원문보기</a>
`, { parse_mode: 'HTML', disable_web_page_preview: true });
                    isPass = false; // 위에서 직접 보냈으므로 하단 공통 전송은 pass
                } 
                
                /* -------------------------------------------
                   [분기 2] 공급계약 / 바이오 / 투자 등 일반 호재
                ------------------------------------------- */
                else {
                    const docDetail = await getDartDetail(rcpNo);
                    tag = extractHotKeyword(title, docDetail);

                    // A. 공급계약 정밀 분석
                    if (title.includes("단일판매") || title.includes("공급계약")) {
                        const ratioMatch = docDetail.match(/매출액\s*대비\s*\(?\s*%\s*\)?\s*([\d.]+)/i);
                        const contractorMatch = docDetail.match(/계약상대방\s*[:\s-]*\s*([가-힣\w\s(株)\(\)]{2,})/i);
                        
                        if (ratioMatch) {
                            const ratio = parseFloat(ratioMatch[1]);
                            const contractor = contractorMatch ? contractorMatch[1].trim().split("회사와의")[0] : "확인불가";
                            
                            if (ratio >= 30) {
                                isPass = true;
                                extraInfo = `\n\n💰 <b>계약상대:</b> ${contractor}`;
                                extraInfo += ratio >= 70 
                                    ? `\n🔴🔴 <b>[대형수주] 매출액 대비 ${ratio}%!</b>` 
                                    : `\n🔴 <b>[수주] 매출액 대비 ${ratio}%</b>`;
                            }
                        }
                    }
                    // B. 바이오/기술/로봇 (키워드 매칭)
                    else if (HOT_KEYWORDS.test(title)) {
                        isPass = true;
                        const bioInfo = await getBioNewFromOpenDart(rcpNo);
                        const resultText = bioInfo.clinicalResult || "";

                        // .match는 문자열인 resultText에서 수행해야 합니다.
                        const isSuccess = /통계적\s*유의성|확보|달성|성공|탑라인/i.test(resultText);

                        extraInfo = isSuccess 
                            ? `\n🔥 <b>[핵심 결과 발표] 데이터 유의성 확보</b>\n📝 <b>내용:</b> ${resultText.slice(0, 1000)}...` 
                            : `\n🧬 <b>[바이오/기술] 공시 감지</b>\n📝 <b>내용:</b> ${resultText.slice(0, 300)}...`;
                    }
                    // C. 대기업 투자유치 / M&A
                    else if (title.includes("양수도") || title.includes("최대주주") || title.includes("제3자배정")) {
                        isPass = true;
                        const match = docDetail.match(/(?:양수인|배정대상자)\s*[:\s-]*\s*([가-힣\w\s(株)\(\)]{2,})/i);
                        let player = match ? match[1].trim().split("(")[0].trim() : "본문 참조";
                        extraInfo = SUPER_INVESTORS.test(player) ? `\n💎 <b>[특급 투자자: ${player}]</b>` : `\n🤝 <b>[투자 유치: ${player}]</b>`;
                    }

                    // 최종 전송 (일반 호재일 경우만)
                    if (isPass) {
                        const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
                        await bot.sendMessage(targetChatId,
                            `🚨 <b>[DART ${tag}]</b>\n\n<b>기업명:</b> ${corp}\n📄 <b>공시제목:</b> ${title}${extraInfo}\n🏢 <b>전송시간:${timeNow}</b>\n\n🔗 <a href="${link}">원문 보기</a>`,
                            { parse_mode: 'HTML', disable_web_page_preview: true }
                        );
                    }
                }

                if (!isTest) sentSet.add(key);
                await new Promise(res => setTimeout(res, 400)); // 도배 방지
            }
        } catch (e) {
            console.error(`Page ${page} 스캔 중 에러 발생: ${e.message}`);
        }
    }
}

/* ======================
    🤖 명령어 처리
====================== */
bot.onText(/\/on/, (msg) => {
    targetChatId = msg.chat.id;
    if (!isMonitoring) {
        isMonitoring = true;
        lastMarketStatus = true; // 켤 때 상태 초기화
        bot.sendMessage(targetChatId, "🚀 <b>실시간 모니터링 가동 시작</b>");
        // 15초마다 최신 15건 스캔
        monitorTimer = setInterval(() => scanDart(15, false), 15000);
    }
});

bot.onText(/\/off/, (msg) => {
    isMonitoring = false;
    clearInterval(monitorTimer);
    bot.sendMessage(msg.chat.id, "🛑 <b>모니터링 중지</b>");
});

// /test1000 [날짜] 명령어 처리
bot.onText(/\/test1000(?:\s+(\d{8}))?/, async (msg, match) => {
    targetChatId = msg.chat.id;
    const testDate = match[1] || moment().format('YYYYMMDD');
    bot.sendMessage(targetChatId, `📊 <b>${testDate}</b> 기준 1,000건 시뮬레이션 시작...`);
    await scanDart(1000, true, testDate);
    bot.sendMessage(targetChatId, `✅ <b>시뮬레이션 완료</b>`);
});

bot.on('polling_error', (err) => console.log('Polling Error:', err.code));

console.log('🚀 DART Intelligent Bot is Online...');