// 데이터 단일 진실 — 5개 챕터 × 13개 기능. 문자열은 전부 i18n 키. tc = 데모 타임코드 표기.
export const CHAPTERS = [
  {
    id: 'ch1',
    numeral: 'I',
    glyph: 'star',
    vignette: '/assets/art/vignette-ch1.webp',
    features: [
      { id: 'feat1', tc: '01:08', video: '/assets/demos/feat1.mp4' },
      { id: 'feat2', tc: '00:36', video: '/assets/demos/feat2.mp4' },
    ],
  },
  {
    id: 'ch2',
    numeral: 'II',
    glyph: 'vault',
    vignette: '/assets/art/vignette-ch2.webp',
    features: [
      { id: 'feat3', tc: '00:10', video: '/assets/demos/feat3.mp4' },
      { id: 'feat4', tc: '00:10', video: '/assets/demos/feat4.mp4' },
      { id: 'feat5', tc: '00:10', video: '/assets/demos/feat5.mp4' },
      { id: 'feat6', tc: '00:10', video: '/assets/demos/feat6.mp4' },
    ],
  },
  {
    id: 'ch3',
    numeral: 'III',
    glyph: 'wing',
    vignette: '/assets/art/vignette-ch3.webp',
    features: [
      { id: 'feat7', tc: '00:55', video: '/assets/demos/feat7.mp4' },
      { id: 'feat8', tc: '00:28', video: '/assets/demos/feat8.mp4' },
      { id: 'feat13', tc: '00:05', video: '/assets/demos/feat13.mp4' },
    ],
  },
  {
    id: 'ch4',
    numeral: 'IV',
    glyph: 'forge',
    vignette: '/assets/art/vignette-ch4.webp',
    features: [
      { id: 'feat9', tc: '00:05', video: '/assets/demos/feat9.mp4' },
      { id: 'feat10', tc: '00:38', video: '/assets/demos/feat10.mp4' },
    ],
  },
  {
    id: 'ch5',
    numeral: 'V',
    glyph: 'moon',
    vignette: '/assets/art/vignette-ch5.webp',
    features: [
      { id: 'feat11', tc: '00:28', video: '/assets/demos/feat11.mp4' },
      { id: 'feat12', tc: '00:05', video: '/assets/demos/feat12.mp4' },
    ],
  },
];

export const TOTAL_FEATURES = CHAPTERS.reduce((n, c) => n + c.features.length, 0);
