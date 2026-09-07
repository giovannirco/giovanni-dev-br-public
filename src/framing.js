export function orbitViewport(width, height, panels = []) {
  let left = 24, right = width - 24, top = width < 760 ? 125 : 155, bottom = height - 24;
  for (const panel of panels) {
    if (panel.width > width * 0.6) bottom = Math.min(bottom, panel.y - 18);
    else if (panel.x < width / 2) left = Math.max(left, panel.x + panel.width + 24);
    else right = Math.min(right, panel.x - 24);
  }
  bottom = Math.max(top + 100, bottom);
  right = Math.max(left + 100, right);
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

export function orbitDistance(radius, fov, height, viewport) {
  const pixels = Math.max(60, Math.min(viewport.width, viewport.height) * 0.76);
  const tangent = Math.tan(fov * Math.PI / 360) * pixels / height;
  return radius * Math.sqrt(1 + 1 / (tangent * tangent));
}
