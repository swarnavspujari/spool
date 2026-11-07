// @ts-check
/**
 * Tests for e2e/save-check.js: the pure checks that the end-to-end specs run on the saved files and
 * on the thumbnail. A check that cannot fail would let a broken save step pass, so each rule gets
 * a case that must be reported.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  boxReduce,
  expectedThumbnail,
  meanAbsDifference,
  savePathProblems,
  seamProblems,
  thumbnailProblems,
} from '../../e2e/save-check.js';

/**
 * A decoded RGB image from a function of the pixel position.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => number[]} colour
 */
function image(width, height, colour) {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      data.set([r, g, b], (y * width + x) * 3);
    }
  }
  return { width, height, channels: 3, data };
}

describe('savePathProblems', () => {
  /** @param {number} y @param {number} mo @param {number} d @param {number} h @param {number} mi @param {number} s */
  const local = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();
  const run = { notBefore: local(2026, 11, 6, 12, 0, 0), notAfter: local(2026, 11, 6, 12, 5, 0) };
  const base = 'Spool 2026-11-06 12.01.02 Chat';
  const expected = (/** @type {number} */ tileCount) => ({ folder: 'Spool', title: 'Chat', tileCount, ...run });

  it('accepts one flat file for one tile', () => {
    assert.deepEqual(savePathProblems([`Spool/${base}.png`], expected(1)), []);
  });

  it('accepts the full image and every tile for a long capture, in any order', () => {
    const paths = [
      `Spool/Spool for AI/${base}/screenshot-02-of-02.png`,
      `Spool/${base}.png`,
      `Spool/Spool for AI/${base}/screenshot-01-of-02.png`,
    ];
    assert.deepEqual(savePathProblems(paths, expected(2)), []);
  });

  it('widens the tile numbers from 100 tiles on', () => {
    const paths = [`Spool/${base}.png`];
    for (let i = 1; i <= 100; i++) {
      const n = String(i).padStart(3, '0');
      paths.push(`Spool/Spool for AI/${base}/screenshot-${n}-of-100.png`);
    }
    assert.deepEqual(savePathProblems(paths, expected(100)), []);
    paths[5] = paths[5].replace('screenshot-005-of-100', 'screenshot-05-of-100');
    assert.match(savePathProblems(paths, expected(100)).join('\n'), /missing tile file: .*screenshot-005-of-100/);
  });

  it('reports no file at all', () => {
    const problems = savePathProblems([], expected(1));
    assert.match(problems.join('\n'), /0 file\(s\) were saved; expected 1/);
  });

  it('reports a wrong number of files', () => {
    const problems = savePathProblems([`Spool/${base}.png`], expected(3));
    assert.match(problems.join('\n'), /1 file\(s\) were saved; expected 4/);
    assert.match(problems.join('\n'), /missing tile file: Spool\/Spool for AI\/.*screenshot-03-of-03\.png/);
  });

  it('reports the tiles written as a flat file or in the wrong folder', () => {
    const wrongFolder = [
      `Spool/${base}.png`,
      `Spool/tiles/${base}/screenshot-01-of-02.png`,
      `Spool/Spool for AI/${base}/screenshot-02-of-02.png`,
    ];
    assert.match(savePathProblems(wrongFolder, expected(2)).join('\n'), /unexpected file: Spool\/tiles/);
    assert.match(savePathProblems(wrongFolder, expected(2)).join('\n'), /missing tile file: .*screenshot-01-of-02/);
  });

  it('reports another root folder, another title and a name without a stamp', () => {
    assert.match(savePathProblems([`Other/${base}.png`], expected(1)).join('\n'), /does not look like/);
    assert.match(savePathProblems(['Spool/Spool 2026-11-06 12.01.02 Other.png'], expected(1)).join('\n'), /does not look like/);
    assert.match(savePathProblems(['Spool/Spool Chat.png'], expected(1)).join('\n'), /does not look like/);
    assert.match(savePathProblems([`Spool/${base}.jpg`], expected(1)).join('\n'), /does not look like/);
  });

  it('reports a time that is outside the run, and takes the window ends in', () => {
    const early = savePathProblems(['Spool/Spool 2026-11-06 11.00.00 Chat.png'], expected(1));
    assert.match(early.join('\n'), /outside the run/);
    const late = savePathProblems(['Spool/Spool 2026-11-06 13.00.00 Chat.png'], expected(1));
    assert.match(late.join('\n'), /outside the run/);
    // The stamp has a resolution of one second: a stamp in the second of notBefore is fine.
    assert.deepEqual(savePathProblems(['Spool/Spool 2026-11-06 12.00.00 Chat.png'], expected(1)), []);
    assert.deepEqual(savePathProblems(['Spool/Spool 2026-11-06 12.05.00 Chat.png'], expected(1)), []);
    assert.match(
      savePathProblems(['Spool/Spool 2026-11-06 12.05.01 Chat.png'], expected(1)).join('\n'),
      /outside the run/,
    );
  });

  it('escapes the title and the folder as text', () => {
    const odd = { folder: 'My.Folder', title: 'a+b (1)', tileCount: 1, ...run };
    assert.deepEqual(
      savePathProblems(['My.Folder/Spool 2026-11-06 12.01.02 a+b (1).png'], odd),
      [],
    );
    assert.match(
      savePathProblems(['MyXFolder/Spool 2026-11-06 12.01.02 a+b (1).png'], odd).join('\n'),
      /does not look like/,
    );
  });
});

describe('expectedThumbnail', () => {
  it('fits a narrow tall image into 320 x 480 and keeps its shape', () => {
    assert.deepEqual(expectedThumbnail(480, 28_000), { srcHeight: 720, width: 320, height: 480 });
  });

  it('never scales up', () => {
    assert.deepEqual(expectedThumbnail(200, 300), { srcHeight: 300, width: 200, height: 300 });
  });

  it('is limited by the width of a wide image', () => {
    assert.deepEqual(expectedThumbnail(1000, 5000), { srcHeight: 1500, width: 320, height: 480 });
    assert.deepEqual(expectedThumbnail(1000, 600), { srcHeight: 600, width: 320, height: 192 });
  });
});

describe('boxReduce and meanAbsDifference', () => {
  it('averages the blocks of the top rows only', () => {
    const img = image(4, 4, (x, y) => (y < 2 ? [x < 2 ? 0 : 100, 10, 20] : [250, 250, 250]));
    const out = boxReduce(img, 2, 2, 1);
    assert.deepEqual([...out], [0, 10, 20, 100, 10, 20]);
  });

  it('measures the mean difference over all channels', () => {
    const img = image(2, 1, () => [10, 20, 30]);
    assert.equal(meanAbsDifference(img, Uint8Array.from([10, 20, 30, 10, 20, 30])), 0);
    assert.equal(meanAbsDifference(img, Uint8Array.from([13, 20, 30, 10, 20, 30])), 0.5);
  });

  it('reads RGBA images by their channel count', () => {
    const rgba = { width: 1, height: 1, channels: 4, data: Uint8Array.from([5, 6, 7, 255]) };
    assert.equal(meanAbsDifference(rgba, Uint8Array.from([5, 6, 7])), 0);
    assert.deepEqual([...boxReduce(rgba, 1, 1, 1)], [5, 6, 7]);
  });
});

describe('thumbnailProblems', () => {
  // A 480 x 1000 full image: dark header, then stripes of blue; the thumbnail is the top 720 rows.
  const full = image(480, 1000, (_x, y) => (y < 48 ? [16, 24, 48] : [y % 16 < 8 ? 40 : 41, 0, 200]));
  const good = () => {
    const out = boxReduce(full, 720, 320, 480);
    return { width: 320, height: 480, channels: 3, data: out };
  };

  it('accepts the reduction of the top of the image', () => {
    assert.deepEqual(
      thumbnailProblems({ thumbnail: good(), full, reportedWidth: 320, reportedHeight: 480 }),
      [],
    );
  });

  it('reports a blank thumbnail', () => {
    const blank = image(320, 480, () => [255, 255, 255]);
    const problems = thumbnailProblems({ thumbnail: blank, full, reportedWidth: 320, reportedHeight: 480 });
    assert.match(problems.join('\n'), /mean difference/);
  });

  it('reports the thumbnail of another part of the image', () => {
    const shifted = boxReduce(
      image(480, 1000, (_x, y) => (y > 700 ? [200, 10, 10] : [16, 24, 48])),
      720,
      320,
      480,
    );
    const problems = thumbnailProblems({
      thumbnail: { width: 320, height: 480, channels: 3, data: shifted },
      full: image(480, 1000, (_x, y) => (y < 100 ? [16, 24, 48] : [90, 90, 250])),
      reportedWidth: 320,
      reportedHeight: 480,
    });
    assert.match(problems.join('\n'), /mean difference/);
  });

  it('reports a size that differs from the summary or from the rule', () => {
    const tiny = image(10, 10, () => [0, 0, 0]);
    const a = thumbnailProblems({ thumbnail: tiny, full, reportedWidth: 320, reportedHeight: 480 });
    assert.match(a.join('\n'), /the summary says 320x480/);
    assert.match(a.join('\n'), /must fit 320x480 as 320x480/);
    const b = thumbnailProblems({ thumbnail: good(), full, reportedWidth: 321, reportedHeight: 480 });
    assert.match(b.join('\n'), /the summary says 321x480/);
  });

  it('allows one pixel of rounding in the size', () => {
    const oneOff = image(320, 479, () => [16, 24, 48]);
    const problems = thumbnailProblems({ thumbnail: oneOff, full, reportedWidth: 320, reportedHeight: 479 });
    assert.ok(!problems.some((p) => /must fit/.test(p)));
  });

  it('applies the tolerance that the caller gives', () => {
    const slightly = good();
    slightly.data = Uint8Array.from(slightly.data, (v) => Math.min(255, v + 20));
    const strict = thumbnailProblems({ thumbnail: slightly, full, reportedWidth: 320, reportedHeight: 480 });
    assert.match(strict.join('\n'), /mean difference/);
    const loose = thumbnailProblems({
      thumbnail: slightly,
      full,
      reportedWidth: 320,
      reportedHeight: 480,
      maxMeanDiff: 25,
    });
    assert.deepEqual(loose, []);
  });
});

describe('seamProblems', () => {
  it('accepts a first frame and joins that were checked', () => {
    assert.deepEqual(seamProblems(['first', 'exact', 'corrected', 'duplicate', 'ambiguous']), []);
    assert.deepEqual(seamProblems(['first']), []);
  });

  it('reports no frame at all', () => {
    assert.match(seamProblems([]).join('\n'), /no frame reply was seen/);
  });

  it('reports an unmatched join with its frame number', () => {
    const problems = seamProblems(['first', 'exact', 'unmatched', 'exact']);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /frame 3 has seam status "unmatched"/);
  });

  it('reports a first frame that is not first, and an unknown status', () => {
    assert.match(seamProblems(['exact']).join('\n'), /frame 1 has seam status "exact", not "first"/);
    assert.match(seamProblems(['first', undefined]).join('\n'), /frame 2 has seam status "undefined"/);
    assert.match(seamProblems(['first', 'first']).join('\n'), /frame 2 has seam status "first"/);
  });
});
