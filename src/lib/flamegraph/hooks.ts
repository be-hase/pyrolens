import { useCallback, useEffect, useRef, useState } from 'react';

import { type FlameGraphDataContainer } from './FlameGraph/dataTransform';
import { ColorScheme, ColorSchemeDiff } from './types';

/**
 * Manages the color scheme state, resetting it when the data changes between
 * diff and non-diff profiles.
 */
export function useColorScheme(
  dataContainer: FlameGraphDataContainer | undefined,
) {
  const defaultColorScheme = dataContainer?.isDiffFlamegraph()
    ? ColorSchemeDiff.Default
    : ColorScheme.PackageBased;
  const [colorScheme, setColorScheme] = useState<ColorScheme | ColorSchemeDiff>(
    defaultColorScheme,
  );

  useEffect(() => {
    setColorScheme(defaultColorScheme);
  }, [defaultColorScheme]);

  return [colorScheme, setColorScheme] as const;
}

/**
 * Replacement for `react-use`'s `useMeasure`: returns a ref callback and the
 * observed content-box size of the element it is attached to.
 */
export function useMeasure<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setSize((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  const ref = useCallback((node: T | null) => {
    setElement(node);
  }, []);

  return [ref, size];
}

/** Replacement for `react-use`'s `usePrevious`. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}
