import type { CSSProperties } from "react";

// Place the entire box on one side of the cursor, preserving the minimum gap
// even when the box needs to flip or shrink to fit the viewport.
export function getNominationPopupStyle(
  cursor: { x: number; y: number },
  viewport: { width: number; height: number },
  distance: number,
  rootFontSize = 16,
): CSSProperties | undefined {
  const margin = 8;
  const width = Math.min(26 * rootFontSize, viewport.width - margin * 2);
  const height = Math.min(18 * rootFontSize, viewport.height - margin * 2);
  if (width <= 0 || height <= 0) return;

  const below = viewport.height - cursor.y - distance - margin;
  const above = cursor.y - distance - margin;
  const openAbove = below < height && above > below;
  const verticalSpace = openAbove ? above : below;
  if (verticalSpace >= Math.min(80, height)) {
    return {
      width,
      left: Math.max(margin, Math.min(cursor.x - width / 2, viewport.width - width - margin)),
      ...(openAbove
        ? { bottom: Math.max(margin, viewport.height - cursor.y + distance) }
        : { top: Math.max(margin, cursor.y + distance) }),
      maxHeight: Math.min(height, verticalSpace),
    };
  }

  const right = viewport.width - cursor.x - distance - margin;
  const left = cursor.x - distance - margin;
  const openLeft = left > right;
  const horizontalSpace = openLeft ? left : right;
  if (horizontalSpace < Math.min(80, width)) return;
  return {
    width: Math.min(width, horizontalSpace),
    top: Math.max(margin, Math.min(cursor.y - height / 2, viewport.height - height - margin)),
    ...(openLeft
      ? { right: Math.max(margin, viewport.width - cursor.x + distance) }
      : { left: Math.max(margin, cursor.x + distance) }),
    maxHeight: height,
  };
}
