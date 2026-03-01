#!/usr/bin/env node
/**
 * Optimize photos for Facebook posting.
 *
 * Features:
 * - EXIF auto-rotation (handles phone photos with rotation metadata)
 * - Flattens alpha/transparency to white background (PNG support)
 * - Analyzes brightness, contrast, and saturation
 * - Auto-adjusts exposure for dark/bright images
 * - Boosts saturation conditionally (skips already-vivid images)
 * - Enhances contrast for flat images via linear adjustment
 * - Smart-crops to Facebook-optimal aspect ratio using saliency detection
 *   - Single photo: 1080x1350 (4:5 portrait)
 *   - Multi-photo:  1080x1080 (1:1 square)
 * - Skips upscaling if source is smaller than target
 * - Post-resize sharpening to retain detail
 * - Batch mode: process multiple photos in one invocation
 *
 * Usage:
 *   node optimize_photo.mjs --input photo.jpg --output /tmp/fb.jpg --mode single|multi
 *   node optimize_photo.mjs --batch '[{"input":"/tmp/a.jpg","output":"/tmp/fb_1.jpg"},...]' --mode multi
 *
 * Output (stdout): JSON with success, adjustments made, and file sizes.
 *   Single: { success, input, output, adjustments, ... }
 *   Batch:  { success, results: [{ success, input, output, adjustments, ... }, ...] }
 */

import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import sharp from "sharp";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    mode: { type: "string", default: "multi" },
    batch: { type: "string" },
  },
});

const TARGETS = {
  single: { width: 1080, height: 1350 }, // 4:5 portrait
  multi: { width: 1080, height: 1080 },  // 1:1 square
};

const target = TARGETS[values.mode] ?? TARGETS.multi;

/**
 * Optimize a single photo. Returns a result object.
 */
async function optimizePhoto(inputPath, outputPath) {
  const image = sharp(inputPath).rotate(); // EXIF auto-rotation
  const metadata = await image.metadata();
  const stats = await image.stats();

  // After EXIF rotation, dimensions may be swapped
  const srcW = metadata.orientation && metadata.orientation >= 5
    ? (metadata.height ?? 0)
    : (metadata.width ?? 0);
  const srcH = metadata.orientation && metadata.orientation >= 5
    ? (metadata.width ?? 0)
    : (metadata.height ?? 0);

  const hasAlpha = metadata.channels === 4 || metadata.hasAlpha;

  // Perceived luminance (ITU-R BT.601)
  const brightness =
    0.299 * stats.channels[0].mean +
    0.587 * stats.channels[1].mean +
    0.114 * stats.channels[2].mean;

  // Contrast estimate: average standard deviation across RGB channels
  const contrast =
    (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;

  // Saturation estimate: spread between max and min channel means
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
  let saturationFactor = 1.0;
  if (saturationSpread < 50) {
    saturationFactor = 1.15;
    adjustments.push("saturation +15%");
  } else if (saturationSpread < 80) {
    saturationFactor = 1.08;
    adjustments.push("saturation +8%");
  }

  // --- Build pipeline ---
  let pipeline = sharp(inputPath).rotate(); // EXIF auto-rotation
  adjustments.push("auto-rotated");

  // Flatten alpha channel to white background (for PNG transparency)
  if (hasAlpha) {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    adjustments.push("flattened transparency");
  }

  // Apply brightness/saturation via modulate (only if needed)
  if (brightnessFactor !== 1.0 || saturationFactor !== 1.0) {
    pipeline = pipeline.modulate({
      brightness: brightnessFactor,
      saturation: saturationFactor,
    });
  }

  // Contrast enhancement for flat images (low stdev)
  if (contrast < 40) {
    const contrastMultiplier = Math.min(1.3, 55 / contrast);
    pipeline = pipeline.linear(contrastMultiplier, -(contrastMultiplier - 1) * 128);
    adjustments.push(`contrast +${((contrastMultiplier - 1) * 100).toFixed(0)}%`);
  }

  // --- Resize / crop ---
  const needsDownscale = srcW > target.width || srcH > target.height;

  if (needsDownscale) {
    pipeline = pipeline.resize(target.width, target.height, {
      fit: "cover",
      position: "attention",
    });
    adjustments.push(`cropped to ${target.width}x${target.height}`);
  } else {
    pipeline = pipeline.resize(target.width, target.height, {
      fit: "inside",
      withoutEnlargement: true,
    });
    adjustments.push(`fit within ${target.width}x${target.height} (no upscale)`);
  }

  // Post-resize sharpening
  pipeline = pipeline.sharpen({ sigma: 0.8, m1: 0.5, m2: 0.3 });
  adjustments.push("sharpened");

  // Output as high-quality JPEG with mozjpeg
  pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });

  await pipeline.toFile(outputPath);

  const inputStat = await stat(inputPath);
  const outputStat = await stat(outputPath);

  return {
    success: true,
    input: inputPath,
    output: outputPath,
    originalDimensions: `${srcW}x${srcH}`,
    outputDimensions: `${target.width}x${target.height}`,
    originalSize: inputStat.size,
    optimizedSize: outputStat.size,
    meanBrightness: Math.round(brightness),
    contrast: Math.round(contrast),
    adjustments,
  };
}

// --- Main ---
try {
  if (values.batch) {
    // Batch mode: process multiple photos
    const items = JSON.parse(values.batch);
    const results = await Promise.all(
      items.map(item => optimizePhoto(item.input, item.output).catch(err => ({
        success: false,
        input: item.input,
        error: err.message,
      })))
    );
    console.log(JSON.stringify({ success: results.every(r => r.success), results }));
  } else {
    // Single mode
    if (!values.input || !values.output) {
      console.log(JSON.stringify({ error: "Usage: --input FILE --output FILE [--mode single|multi]  OR  --batch JSON [--mode single|multi]" }));
      process.exit(1);
    }
    const result = await optimizePhoto(values.input, values.output);
    console.log(JSON.stringify(result));
  }
} catch (err) {
  console.log(JSON.stringify({ error: `Failed to optimize: ${err.message}` }));
  process.exit(1);
}
