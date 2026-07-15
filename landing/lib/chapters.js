// 데이터 단일 진실 — 5개 챕터 × 13개 기능. 문자열은 전부 i18n 키. tc = 데모 타임코드 표기.
export const CHAPTERS = [
  {
    id: 'ch1',
    numeral: 'I',
    glyph: 'star',
    vignette: '/assets/art/vignette-ch1.webp',
    features: [
      { id: 'feat1', tc: '00:12' },
      { id: 'feat2', tc: '00:18' },
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
      { id: 'feat7', tc: '00:09' },
      { id: 'feat8', tc: '00:13' },
      { id: 'feat13', tc: '00:14' },
    ],
  },
  {
    id: 'ch4',
    numeral: 'IV',
    glyph: 'forge',
    vignette: '/assets/art/vignette-ch4.webp',
    features: [
      { id: 'feat9', tc: '00:16' },
      { id: 'feat10', tc: '00:10' },
    ],
  },
  {
    id: 'ch5',
    numeral: 'V',
    glyph: 'moon',
    vignette: '/assets/art/vignette-ch5.webp',
    features: [
      { id: 'feat11', tc: '00:17' },
      { id: 'feat12', tc: '00:08' },
    ],
  },
];

export const TOTAL_FEATURES = CHAPTERS.reduce((n, c) => n + c.features.length, 0);
