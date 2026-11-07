import type { CSSProperties } from "react";

export function getNominationSummary(canDo: number, maybe: number, total: number) {
  const available = canDo + maybe;
  const color = total > 0 && available === total ? "green"
    : total > 0 && available * 2 >= total ? "yellow"
    : "red";
  return { available, maybe, total, color };
}

// Place the entire box on one side of the cursor, preserving the minimum gap
// even when the box needs to flip or shrink to fit the viewport.
export function getNominationPopupStyle(
  cursor: { x: number; y: number },
  viewport: { width: number; height: number },
  distance: number,
  rootFontSize = 16,
  preferredWidth = 26 * rootFontSize,
): CSSProperties | undefined {
  const margin = 8;
  const viewportWidth = viewport.width - margin * 2;
  const viewportHeight = viewport.height - margin * 2;
  if (viewportWidth <= 0 || viewportHeight <= 0) return;

  const belowTop = Math.max(margin, cursor.y + distance);
  const aboveBottom = Math.max(margin, viewport.height - cursor.y + distance);
  const below = viewport.height - belowTop - margin;
  const above = viewport.height - aboveBottom - margin;
  const openAbove = above > below;
  const verticalSpace = openAbove ? above : below;
  if (verticalSpace >= Math.min(80, viewportHeight)) {
    const width = Math.min(preferredWidth, viewportWidth);
    return {
      width,
      maxWidth: viewportWidth,
      left: Math.max(margin, Math.min(cursor.x - width / 2, viewport.width - width - margin)),
      ...(openAbove
        ? { bottom: aboveBottom }
        : { top: belowTop }),
      maxHeight: verticalSpace,
    };
  }

  const right = viewport.width - cursor.x - distance - margin;
  const left = cursor.x - distance - margin;
  const openLeft = left > right;
  const horizontalSpace = openLeft ? left : right;
  if (horizontalSpace < Math.min(80, viewportWidth)) return;
  return {
    width: Math.min(preferredWidth, horizontalSpace),
    maxWidth: horizontalSpace,
    top: margin,
    ...(openLeft
      ? { right: Math.max(margin, viewport.width - cursor.x + distance) }
      : { left: Math.max(margin, cursor.x + distance) }),
    maxHeight: viewportHeight,
  };
}

// Keep participants in order and fill each column's available height before
// starting the next. Every participant appears once, including oversized rows.
export function splitNominationColumns<T>(
  people: readonly T[],
  availableHeight: number,
  rowHeight: (person: T) => number,
): T[][] {
  const columns: T[][] = [[]];
  let height = 0;
  for (const person of people) {
    const nextHeight = rowHeight(person);
    if (columns[columns.length - 1].length > 0 && height + nextHeight > availableHeight) {
      columns.push([]);
      height = 0;
    }
    columns[columns.length - 1].push(person);
    height += nextHeight;
  }
  return columns;
}
