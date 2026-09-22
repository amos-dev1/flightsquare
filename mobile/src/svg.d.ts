/**
 * `.svg` files are components, not asset URIs.
 *
 * `react-native-svg-transformer` turns them into React components at bundle
 * time (see metro.config.js), which is how §11's approved artwork gets to
 * stay a single file rather than path data copied into a `.tsx`. The package
 * ships no declarations, so the shape is stated here.
 */
declare module '*.svg' {
  import type { FC } from 'react';
  import type { SvgProps } from 'react-native-svg';

  const content: FC<SvgProps>;
  export default content;
}
