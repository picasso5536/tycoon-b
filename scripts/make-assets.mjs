/**
 * 앱 아이콘 / 스플래시 원본(PNG) 생성
 *
 * 게임 안에서 쓰는 붕어빵 SVG(index.html 의 fishSVG)와 같은 형태·팔레트를 사용해
 * 아이콘과 스플래시를 그린 뒤, @capacitor/assets 가 소비할 원본 PNG 로 굽는다.
 *
 *   assets/icon.png             1024x1024  (불투명, 라이트/다크 공용)
 *   assets/icon-foreground.png  1024x1024  (안드로이드 적응형 아이콘 전경, 투명)
 *   assets/icon-background.png  1024x1024  (안드로이드 적응형 아이콘 배경)
 *   assets/splash.png           2732x2732  (라이트)
 *   assets/splash-dark.png      2732x2732  (다크)
 *   assets/favicon.png          192x192    (웹뷰/브라우저 탭 아이콘)
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

/** 게임 팔레트 (index.html :root 변수와 동일) */
const C = {
  night: '#141b2e',
  night0: '#0d1322',
  night2: '#1d2740',
  golden: '#d98a2b',
  glow: '#ffb347',
  batter: '#f2dfb6',
  ink: '#fff6ea',
};

/** index.html 의 fishSVG 와 동일한 패스 — 앱 아이콘과 게임 그래픽을 일치시킨다 */
const FISH_BODY =
  'M8 30 Q8 8 38 8 L64 8 Q86 8 90 22 L98 12 L96 30 L98 48 L90 38 Q86 52 64 52 L38 52 Q8 52 8 30 Z';
const FISH_SCORE =
  'M30 16 Q34 30 30 44 M42 14 Q46 30 42 46 M54 14 Q58 30 54 46 M66 15 Q70 30 66 45';

/** 붕어빵 한 마리 (viewBox 0 0 100 60 기준) */
function fish({ x, y, scale, rotate = 0, opacity = 1, color = C.golden }) {
  return `
  <g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale}) translate(-50 -30)" opacity="${opacity}">
    <path d="${FISH_BODY}" fill="${color}" stroke="#00000038" stroke-width="2"/>
    <path d="${FISH_SCORE}" fill="none" stroke="#00000026" stroke-width="3" stroke-linecap="round"/>
    <circle cx="20" cy="24" r="3.4" fill="#3a2410"/>
  </g>`;
}

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.night0}"/>
      <stop offset="0.55" stop-color="${C.night}"/>
      <stop offset="1" stop-color="${C.night2}"/>
    </linearGradient>
    <radialGradient id="lamp" cx="0.5" cy="0.42" r="0.55">
      <stop offset="0" stop-color="${C.glow}" stop-opacity="0.42"/>
      <stop offset="1" stop-color="${C.glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fishGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.batter}"/>
      <stop offset="0.5" stop-color="${C.glow}"/>
      <stop offset="1" stop-color="${C.golden}"/>
    </linearGradient>
  </defs>`;

/** 아이콘 전경: 김이 모락모락 나는 붕어빵 한 마리 */
function iconForeground(size) {
  const c = size / 2;
  return `
  <g>
    <!-- 김 -->
    <g stroke="${C.ink}" stroke-opacity="0.38" stroke-width="${size * 0.022}"
       stroke-linecap="round" fill="none">
      <path d="M${c - size * 0.13} ${c - size * 0.17}
               q ${size * 0.05} -${size * 0.06} 0 -${size * 0.12}
               q -${size * 0.05} -${size * 0.06} 0 -${size * 0.1}"/>
      <path d="M${c + size * 0.01} ${c - size * 0.2}
               q ${size * 0.055} -${size * 0.065} 0 -${size * 0.13}
               q -${size * 0.055} -${size * 0.065} 0 -${size * 0.11}"/>
      <path d="M${c + size * 0.15} ${c - size * 0.17}
               q ${size * 0.05} -${size * 0.06} 0 -${size * 0.12}
               q -${size * 0.05} -${size * 0.06} 0 -${size * 0.1}"/>
    </g>
    <!-- 붕어빵 -->
    <g transform="translate(${c} ${c + size * 0.1}) rotate(-8)
                  scale(${size * 0.0072}) translate(-50 -30)">
      <path d="${FISH_BODY}" fill="url(#fishGrad)" stroke="#5a3410" stroke-width="2.6"/>
      <path d="${FISH_SCORE}" fill="none" stroke="#00000030" stroke-width="3.2" stroke-linecap="round"/>
      <circle cx="20" cy="24" r="3.6" fill="#3a2410"/>
    </g>
  </g>`;
}

function iconSVG(size, { transparentBackground = false } = {}) {
  const bg = transparentBackground
    ? ''
    : `<rect width="${size}" height="${size}" fill="url(#bg)"/>
       <rect width="${size}" height="${size}" fill="url(#lamp)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${defs}${bg}${iconForeground(size)}
  </svg>`;
}

function iconBackgroundSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${defs}
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    <rect width="${size}" height="${size}" fill="url(#lamp)"/>
  </svg>`;
}

/**
 * 스플래시: 정사각 캔버스 가운데에 로고를 두고 나머지는 배경색으로 채운다.
 * (Capacitor 는 이 정사각 원본을 기기 비율에 맞춰 center-crop 한다)
 */
function splashSVG(size) {
  const c = size / 2;
  const logo = size * 0.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${defs}
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    <rect width="${size}" height="${size}" fill="url(#lamp)"/>
    <!-- 배경에 흩뿌린 붕어빵들 -->
    ${fish({ x: size * 0.17, y: size * 0.2, scale: size * 0.0034, rotate: -18, opacity: 0.13 })}
    ${fish({ x: size * 0.84, y: size * 0.26, scale: size * 0.003, rotate: 14, opacity: 0.11 })}
    ${fish({ x: size * 0.2, y: size * 0.79, scale: size * 0.0031, rotate: 10, opacity: 0.11 })}
    ${fish({ x: size * 0.82, y: size * 0.76, scale: size * 0.0036, rotate: -12, opacity: 0.13 })}
    <!-- 가운데 로고 -->
    <g transform="translate(${c - logo / 2} ${c - logo / 2 - size * 0.03})">
      <svg width="${logo}" height="${logo}" viewBox="0 0 ${logo} ${logo}">
        ${iconForeground(logo)}
      </svg>
    </g>
  </svg>`;
}

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(OUT, file));
  console.log(`  ✓ assets/${file} (${size}x${size})`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // 사람이 다시 편집할 수 있도록 SVG 원본도 남겨 둔다
  await writeFile(join(OUT, 'icon.svg'), iconSVG(1024), 'utf8');
  await writeFile(join(OUT, 'splash.svg'), splashSVG(2732), 'utf8');

  await png(iconSVG(1024), 1024, 'icon.png');
  await png(iconSVG(1024, { transparentBackground: true }), 1024, 'icon-foreground.png');
  await png(iconBackgroundSVG(1024), 1024, 'icon-background.png');
  await png(splashSVG(2732), 2732, 'splash.png');
  await png(splashSVG(2732), 2732, 'splash-dark.png');
  await png(iconSVG(1024), 192, 'favicon.png');

  console.log('[make-assets] 완료');
}

main().catch((e) => { console.error(e); process.exit(1); });
