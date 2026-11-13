#!/usr/bin/env node
/*
 * 마음목탁 – 방하착 · mergeStates() 회귀 테스트
 *
 * 저장·동기화 로직(load/save/mergeStates/cloudSync/scheduleCloudPush)이나
 * 상태 스키마를 건드린 변경은 배포 전에 반드시 실행하고 전부 PASS인지 확인한다.
 *
 *   node scripts/test-sync-merge.js
 *
 * 배경: 형제 앱 Mindpullness는 '타임스탬프가 더 최신'인 빈 새 기기 상태가
 * 실제 기록을 통째로 덮어쓰는 사고를 두 번 겪었다. 이 앱은 처음부터 필드 단위
 * 병합을 쓰며, 아래 시나리오로 그 사고가 재현되지 않음을 확인한다.
 *
 * index.html 안의 /*<MERGE>*\/ ~ /*</MERGE>*\/ 사이 코드만 꺼내 실행하므로
 * mergeStates는 DOM·전역 상태에 기대지 않는 순수 함수로 유지해야 한다.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const m = html.match(/\/\*<MERGE>\*\/([\s\S]*?)\/\*<\/MERGE>\*\//);
if (!m) { console.error("FAIL  index.html에서 /*<MERGE>*/ 블록을 찾지 못함"); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1] + "\nthis.mergeStates = mergeStates;", ctx); // 문법 오류면 여기서 바로 실패
const merge = (r, l) => JSON.parse(JSON.stringify(ctx.mergeStates(r, l)));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
}
const blank = (over = {}) => ({
  version: 1, updatedAt: 0,
  settings: { userName: "", startDate: null, onboardingDone: false, safetyAck: false,
    enabledFeatures: ["verse", "practice", "reflect", "calendar", "learn"], sound: true, vibrate: true,
    reduceMotion: false, theme: "light", seenTips: [], lastVisit: null, hiddenResume: [] },
  moods: [], reflections: [], practices: [], savedVerses: [], savedMeta: {},
  lessons: { completed: [], memos: {} }, stickers: [], moktak: {}, deletedIds: [], ...over
});
const T = s => new Date(s).toISOString();

/* 1. Mindpullness 사고 재현: 실제 기록이 있는 서버 vs 방금 온보딩한 빈 새 기기(더 최신 updatedAt) */
{
  const server = blank({
    updatedAt: 1000,
    settings: { ...blank().settings, userName: "정우", onboardingDone: true, safetyAck: true, startDate: "2026-11-01", seenTips: ["home_mood"] },
    moods: [{ id: "m_1", ts: T("2026-11-01T09:00"), date: "2026-11-01", mood: "anxious", note: "회의 전" }],
    reflections: [{ id: "r_1", createdAt: T("2026-11-02T21:00"), updatedAt: T("2026-11-02T21:10"), firstArrow: "발표에서 더듬었다", intensityBefore: 80, intensityAfter: 40, done: true }],
    practices: [{ id: "p_1", date: T("2026-11-03T07:00"), type: "metta", minutes: 3 }],
    savedVerses: ["v05"], savedMeta: { v05: 1700000000000 },
    moktak: { "2026-11-01": 30 }
  });
  const freshPhone = blank({
    updatedAt: 9999999999999,
    settings: { ...blank().settings, userName: "벗", onboardingDone: true, safetyAck: true, startDate: "2026-11-14" }
  });
  const out = merge(server, freshPhone);
  check("빈 새 기기가 기존 마음 기록을 지우지 않음", out.moods.length === 1);
  check("빈 새 기기가 털어놓기 기록을 지우지 않음", out.reflections.length === 1 && out.reflections[0].firstArrow === "발표에서 더듬었다");
  check("빈 새 기기가 수행 기록을 지우지 않음", out.practices.length === 1);
  check("빈 새 기기가 담아 둔 구절을 지우지 않음", out.savedVerses.includes("v05"));
  check("빈 새 기기가 목탁 횟수를 지우지 않음", out.moktak["2026-11-01"] === 30);
  check("시작일은 더 이른 날짜 유지", out.settings.startDate === "2026-11-01");
  check("'벗'보다 실제 이름 유지", out.settings.userName === "정우");
  check("본 도움말 기록 유지", out.settings.seenTips.includes("home_mood"));
  // 방향을 바꿔도(서버가 빈 상태, 기기에 실제 기록) 결과가 같아야 함
  const rev = merge(freshPhone, server);
  check("반대 방향 병합도 기록 보존", rev.moods.length === 1 && rev.reflections.length === 1 && rev.practices.length === 1);
}

/* 2. 두 기기에서 각각 새로 쓴 기록은 모두 살아남음 */
{
  const a = blank({ moods: [{ id: "m_a", ts: T("2026-11-10T08:00"), date: "2026-11-10", mood: "low", note: "" }] });
  const b = blank({ moods: [{ id: "m_b", ts: T("2026-11-10T20:00"), date: "2026-11-10", mood: "okay", note: "" }] });
  const out = merge(a, b);
  check("두 기기의 새 기록 합집합", out.moods.map(x => x.id).join() === "m_a,m_b");
}

/* 3. 한 기기에서 지운 기록은 다른 기기에서 되살아나지 않음 (deletedIds) */
{
  const other = blank({ reflections: [{ id: "r_x", createdAt: T("2026-11-05"), updatedAt: T("2026-11-05"), done: true }] });
  const me = blank({ reflections: [], deletedIds: ["r_x"] });
  check("지운 털어놓기가 되살아나지 않음", merge(other, me).reflections.length === 0);
  check("반대 방향에서도 되살아나지 않음", merge(me, other).reflections.length === 0);
  check("삭제 기록은 합쳐서 보존", merge(other, me).deletedIds.includes("r_x"));
}

/* 4. 같은 기록을 두 기기에서 고쳤으면 더 나중에 고친 쪽 */
{
  const older = blank({ reflections: [{ id: "r_1", createdAt: T("2026-11-05T10:00"), updatedAt: T("2026-11-05T10:05"), firstArrow: "초안", done: false }] });
  const newer = blank({ reflections: [{ id: "r_1", createdAt: T("2026-11-05T10:00"), updatedAt: T("2026-11-05T11:00"), firstArrow: "완성본", done: true }] });
  check("더 최근에 고친 털어놓기 채택(서버가 최신)", merge(newer, older).reflections[0].firstArrow === "완성본");
  check("더 최근에 고친 털어놓기 채택(기기가 최신)", merge(older, newer).reflections[0].firstArrow === "완성본");
}

/* 5. 마음 메모: 메모를 단 쪽(updatedAt 있음)이 이김 */
{
  const plain = blank({ moods: [{ id: "m_1", ts: T("2026-11-06T09:00"), date: "2026-11-06", mood: "angry", note: "" }] });
  const noted = blank({ moods: [{ id: "m_1", ts: T("2026-11-06T09:00"), updatedAt: T("2026-11-06T09:02"), date: "2026-11-06", mood: "angry", note: "출근길" }] });
  check("메모를 단 마음 기록 채택", merge(noted, plain).moods[0].note === "출근길");
}

/* 6. 담아 둔 구절: 빼기·다시 담기 모두 마지막 동작이 이김 */
{
  const saved = blank({ savedVerses: ["v10"], savedMeta: { v10: 1000 } });
  const removedLater = blank({ savedVerses: [], savedMeta: { v10: -2000 } });
  check("나중에 뺀 구절은 다시 나타나지 않음", !merge(saved, removedLater).savedVerses.includes("v10"));
  const reSaved = blank({ savedVerses: ["v10"], savedMeta: { v10: 3000 } });
  check("뺀 뒤 다시 담은 구절은 남음", merge(removedLater, reSaved).savedVerses.includes("v10"));
  const legacy = blank({ savedVerses: ["v01", "v02"] }); // savedMeta 없던 이전 데이터
  const out = merge(legacy, blank());
  check("시각 기록 없는 이전 데이터의 담은 구절 보존", out.savedVerses.join() === "v01,v02");
}

/* 7. 목탁 횟수: 같은 날짜는 큰 값 (최대 108 유지) */
{
  const out = merge(blank({ moktak: { "2026-11-07": 20, "2026-11-06": 5 } }), blank({ moktak: { "2026-11-07": 108 } }));
  check("목탁 횟수 날짜별 큰 값", out.moktak["2026-11-07"] === 108 && out.moktak["2026-11-06"] === 5);
}

/* 8. 기기별 설정(소리·진동·쓰는 기능)은 이 기기 값 유지, 안전 고지 확인은 한쪽이라도 true면 true */
{
  const server = blank({ settings: { ...blank().settings, sound: true, enabledFeatures: ["verse"], safetyAck: true, onboardingDone: true } });
  const device = blank({ settings: { ...blank().settings, sound: false, enabledFeatures: ["verse", "practice"], safetyAck: false, onboardingDone: false } });
  const out = merge(server, device);
  check("소리 설정은 이 기기 값", out.settings.sound === false);
  check("쓰는 기능은 이 기기 값", out.settings.enabledFeatures.join() === "verse,practice");
  check("안전 고지·온보딩 완료는 OR", out.settings.safetyAck === true && out.settings.onboardingDone === true);
}

/* 9. 빈 값·누락 필드에도 죽지 않음 */
{
  let ok = true;
  try { merge(null, blank()); merge(blank(), null); merge({}, {}); merge({ moods: [{ id: "m_1" }] }, { moods: null }); } catch (e) { ok = false; console.log("      " + e.message); }
  check("null·빈 객체 입력에도 예외 없음", ok);
  check("null 서버 + 기록 있는 기기 = 기기 기록 유지", merge(null, blank({ moods: [{ id: "m_9", ts: T("2026-11-09") }] })).moods.length === 1);
}

/* 10. 병합을 여러 번 해도 결과가 같음(멱등성) */
{
  const a = blank({ moods: [{ id: "m_a", ts: T("2026-11-01") }], deletedIds: ["m_z"], savedMeta: { v03: 5 }, savedVerses: ["v03"] });
  const b = blank({ moods: [{ id: "m_b", ts: T("2026-11-02") }, { id: "m_z", ts: T("2026-11-03") }] });
  const once = merge(a, b), twice = merge(once, b), thrice = merge(a, once);
  const key = s => JSON.stringify({ m: s.moods.map(x => x.id), d: s.deletedIds, v: s.savedVerses });
  check("병합 결과 멱등", key(once) === key(twice) && key(once) === key(thrice));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
