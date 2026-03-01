#!/usr/bin/env node
/**
 * Optimize a photo for Facebook posting.
 *
 * - Analyzes brightness, contrast, and saturation
 * - Auto-adjusts exposure for dark/bright images
 * - Boosts saturation conditionally (skips already-vivid images)
 * - Enhances contrast for flat images via linear adjustment
 * - Applies post-resize sharpening to retain detail
 * - Smart-crops to Facebook-optimal aspect ratio
 *   - Single photo: 1080x1350 (4:5 portrait)
 *   - Multi-photo:  1080x1080 (1:1 square)
 * - Skips upscaling if source is smaller than target
 *
 * Usage:
 *   node optimize_photo.mjs --input photo.jpg --output /tmp/fb.jpg --mode single|multi
 *
 * Output (stdout): JSON with success, adjustments made, and file sizes.
 */

import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import sharp from "sharp";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    mode: { type: "string", default: "multi" },
  },
});

if (!values.input || !values.output) {
  console.log(JSON.stringify({ error: "Usage: --input FILE --output FILE [--mode single|multi]" }));
  process.exit(1);
}

const TARGETS = {
  single: { width: 1080, height: 1350 }, // 4:5 portrait
  multi: { width: 1080, height: 1080 },  // 1:1 square
};

const target = TARGETS[values.mode] ?? TARGETS.multi;

try {
  const image = sharp(values.input);
  const metadata = await image.metadata();
  const stats = await image.stats();

  // Perceived luminance (ITU-R BT.601)
  const brightness =
    0.299 * stats.channels[0].mean +
    0.587 * stats.channels[1].mean +
    0.114 * stats.channels[2].mean;

  // Contrast estimate: average standard deviation across channels
  const contrast =
    (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;

  // Saturation estimate: difference between max and min channel means
  const channelMeans = stats.channels.slice(0, 3).map(c => c.mean);
  const saturationSpread = Math.max(...channelMeans) - Math.min(...channelMeans);

  const adjustments = [];

  // --- Brightness adjustment ---
  let brightnessFactor = 1.0;
  if (brightness < 85) {
    brightnessFactor = Math.min(1.4, 110 / brightness);
    adjustments.push(`brightness +${((brightnessFactor - 1) * 100).toFixed(0)}%`);
  } else if (brightness > 180) {
    brightnessFactor = Math.max(0.75, 140 / brightness);
    adjustments.push(`brightness ${((brightnessFactor - 1) * 100).toFixed(0)}%`);
  }

  // --- Saturation adjustment (conditional) ---
  // Skip boost if image is already vivid (high channel spread)
  let saturationFactor = 1.0;
  if (saturationSpread < 50) {
    saturationFactor = 1.15;
    adjustments.push("saturation +15%");
  } else if (saturationSpread < 80) {
    saturationFactor = 1.08;
    adjustments.push("saturation +8%");
  }

  // --- Build pipeline ---
  let pipeline = sharp(values.input);

  // Apply brightness/saturation via modulate (only if needed)
  if (brightnessFactor !== 1.0 || saturationFactor !== 1.0) {
    pipeline = pipeline.modulate({
      brightness: brightnessFactor,
      saturation: saturationFactor,
    });
  }

  // Contrast enhancement for flat images (low stdev)
  if (contrast < 40) {
    // linear: multiplier > 1 increases contrast, offset recenters
    const contrastMultiplier = Math.min(1.3, 55 / contrast);
    pipeline = pipeline.linear(contrastMultiplier, -(contrastMultiplier - 1) * 128);
    adjustments.push(`contrast +${((contrastMultiplier - 1) * 100).toFixed(0)}%`);
  }

  // --- Resize / crop ---
  // Don't upscale small images — only downscale or fit
  const srcW = metadata.width ?? 0;
  const srcH = metadata.height ?? 0;
  const needsDownscale = srcW > target.width || srcH > target.height;

  if (needsDownscale) {
    pipeline = pipeline.resize(target.width, target.height, {
      fit: "cover",
      position: "attention",
    });
    adjustments.push(`cropped to ${target.width}x${target.height}`);
  } else {
    // Source is smaller — resize to fit within target without upscaling
    pipeline = pipeline.resize(target.width, target.height, {
      fit: "inside",
      withoutEnlargement: true,
    });
    adjustments.push(`fit within ${target.width}x${target.height} (no upscale)`);
  }

  // Post-resize sharpening to retain detail
  pipeline = pipeline.sharpen({ sigma: 0.8, m1: 0.5, m2: 0.3 });
  adjustments.push("sharpened");

  // Output as high-quality JPEG
  pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });

  await pipeline.toFile(values.output);

  const inputStat = await stat(values.input);
  const outputStat = await stat(values.output);

  console.log(
    JSON.stringify({
      success: true,
      input: values.input,
      output: values.output,
      originalDimensions: `${srcW}x${srcH}`,
      outputDimensions: `${target.width}x${target.height}`,
      originalSize: inputStat.size,
      optimizedSize: outputStat.size,
      meanBrightness: Math.round(brightness),
      contrast: Math.round(contrast),
      adjustments,
    })
  );
} catch (err) {
  console.log(JSON.stringify({ error: `Failed to optimize: ${err.message}` }));
  process.exit(1);
}
