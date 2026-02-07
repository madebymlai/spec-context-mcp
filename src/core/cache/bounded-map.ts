export function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);

  if (maxEntries < 1) {
    map.clear();
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (typeof oldestKey === 'undefined') {
      break;
    }
    map.delete(oldestKey);
  }
}
