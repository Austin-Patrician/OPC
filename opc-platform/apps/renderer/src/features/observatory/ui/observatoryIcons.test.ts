import { describe, expect, it } from 'vitest';
import * as icons from '@/shared/file-icon/file-icon-data';
import { resolveArtifactVisual } from './observatoryIcons';

describe('resolveArtifactVisual', () => {
  it('resolves PNG/image artifacts to the dedicated image SVG icon rather than chart/generic icons', () => {
    expect(resolveArtifactVisual('output/whale_girl.png')).toEqual({
      mode: 'svg',
      svg: icons.icon_image,
    });
    expect(resolveArtifactVisual('output\\preview\\slide_01.JPG')).toEqual({
      mode: 'svg',
      svg: icons.icon_image,
    });
    expect(resolveArtifactVisual('slides/slide_01.svg')).toEqual({
      mode: 'svg',
      svg: icons.icon_svg,
    });
  });

  it('resolves office, media, code, and fallback artifacts consistently with file-icons', () => {
    expect(resolveArtifactVisual('output/Gemini_Pro_订阅推荐.pptx')).toEqual({
      mode: 'svg',
      svg: icons.icon_powerpoint,
    });
    expect(resolveArtifactVisual('output/report.pdf')).toEqual({
      mode: 'svg',
      svg: icons.icon_pdf,
    });
    expect(resolveArtifactVisual('output/sheet.xlsx')).toEqual({
      mode: 'svg',
      svg: icons.icon_table,
    });
    expect(resolveArtifactVisual('output/clip.mp4')).toEqual({
      mode: 'svg',
      svg: icons.icon_video,
    });
    expect(resolveArtifactVisual('output/unknown.bin')).toEqual({
      mode: 'svg',
      svg: icons.icon_file,
    });
  });
});
