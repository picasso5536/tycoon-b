/**
 * 붕어빵 타이쿤 — 네이티브 웹 자산 빌드
 *
 * 루트의 index.html(웹 배포본, 단일 파일)을 원본으로 삼아
 * Capacitor 가 번들할 www/ 를 만든다.
 *
 *  - CDN 의존성(Google Fonts, mqtt.js)을 로컬 번들로 교체 → 오프라인 실행 가능
 *  - viewport-fit=cover 추가 → 노치 대응
 *  - native.css / native.js 주입 → 안전영역·뒤로가기·공유 처리
 *
 * index.html 은 수정하지 않으므로 웹 버전(GitHub Pages)은 그대로 동작한다.
 */
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const VENDOR = join(WWW, 'vendor');
const FONT_DIR = join(VENDOR, 'fonts');

/** 번들할 폰트 서브셋 (@fontsource, SIL Open Font License) */
const FONTS = [
  { family: 'Jua', pkg: '@fontsource/jua', file: 'jua-latin-400-normal' },
  { family: 'Jua', pkg: '@fontsource/jua', file: 'jua-korean-400-normal' },
  { family: 'Gowun Dodum', pkg: '@fontsource/gowun-dodum', file: 'gowun-dodum-latin-400-normal' },
  { family: 'Gowun Dodum', pkg: '@fontsource/gowun-dodum', file: 'gowun-dodum-korean-400-normal' },
];

function must(condition, message) {
  if (!condition) {
    console.error(`\n[build-www] ${message}\n`);
    process.exit(1);
  }
}

/** 한 번만 치환되어야 하는 교체 — 못 찾으면 조용히 넘어가지 않고 실패시킨다 */
function replaceOnce(html, needle, replacement, label) {
  must(html.includes(needle), `index.html 에서 "${label}" 를 찾지 못했습니다. 원본이 바뀌었는지 확인하세요.`);
  return html.replace(needle, replacement);
}

async function buildFonts() {
  await mkdir(FONT_DIR, { recursive: true });
  let css = '/* 번들 폰트 — Jua / Gowun Dodum (SIL Open Font License 1.1) */\n';

  for (const { family, pkg, file } of FONTS) {
    for (const ext of ['woff2', 'woff']) {
      await copyFile(
        join(ROOT, 'node_modules', pkg, 'files', `${file}.${ext}`),
        join(FONT_DIR, `${file}.${ext}`)
      );
    }
    css +=
      `@font-face{font-family:'${family}';font-style:normal;font-weight:400;font-display:swap;` +
      `src:url(./fonts/${file}.woff2) format('woff2'),url(./fonts/${file}.woff) format('woff')}\n`;
  }

  await writeFile(join(VENDOR, 'fonts.css'), css, 'utf8');
}

async function buildMqtt() {
  await copyFile(
    join(ROOT, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js'),
    join(VENDOR, 'mqtt.min.js')
  );
}

async function buildHtml() {
  let html = await readFile(join(ROOT, 'index.html'), 'utf8');

  // 1) 노치 영역까지 화면을 확장
  html = replaceOnce(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">',
    'viewport meta'
  );

  // 2) Google Fonts → 번들 폰트
  html = replaceOnce(
    html,
    '<link href="https://fonts.googleapis.com/css2?family=Jua&family=Gowun+Dodum&display=swap" rel="stylesheet">',
    '<link rel="stylesheet" href="vendor/fonts.css">',
    'Google Fonts link'
  );

  // 3) cdnjs mqtt.js → 번들 mqtt.js
  html = replaceOnce(
    html,
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/mqtt/4.3.7/mqtt.min.js"></script>',
    '<script src="vendor/mqtt.min.js"></script>',
    'mqtt CDN script'
  );

  // 4) 네이티브 보정 자산 주입 (게임 스크립트보다 먼저 실행되어야 함)
  html = replaceOnce(
    html,
    '</head>',
    '<link rel="icon" href="favicon.png">\n' +
      '<link rel="stylesheet" href="native.css">\n' +
      '<script src="native.js"></script>\n</head>',
    '</head>'
  );

  await writeFile(join(WWW, 'index.html'), html, 'utf8');

  // 남아 있는 원격 리소스가 없는지 검증 (오프라인 실행 보장)
  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  must(remote.length === 0, `번들되지 않은 원격 리소스가 남아 있습니다:\n  ${remote.join('\n  ')}`);
}

async function main() {
  await rm(WWW, { recursive: true, force: true });
  await mkdir(VENDOR, { recursive: true });

  await buildFonts();
  await buildMqtt();
  await copyFile(join(ROOT, 'assets/favicon.png'), join(WWW, 'favicon.png'));
  await copyFile(join(ROOT, 'src/native/native.css'), join(WWW, 'native.css'));
  await copyFile(join(ROOT, 'src/native/native.js'), join(WWW, 'native.js'));
  await buildHtml();

  console.log('[build-www] www/ 생성 완료 (폰트·mqtt 번들 포함, 원격 의존성 0개)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
