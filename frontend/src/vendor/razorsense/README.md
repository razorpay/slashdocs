# RazorSense

A copy of the RazorSense component from the Blade
design system (`packages/blade/src/components/Spark` in
https://github.com/razorpay/blade, `@razorpay/blade@12.128.0`, MIT license in
`LICENSE`). We copy them so that the landing page can use them without Blade's
provider, styled-components, and React Native dependencies.

Local changes:

- The color scheme comes from `useResolvedTheme`, not from Blade's provider.
- `useMergeRefs` and `useId` are local or React versions.
- The render loop runs only while the effect is on screen, and draws at most
  30 frames a second. Frame-based animations count frames at 60 fps. The
  FPS monitor runs only while the render loop runs.
- Each tier renders fewer pixels: about 1080p at most, at 1x.
- `dispose()` and the GPU check release their WebGL contexts.
- Assets load from `/razorsense` on our own origin, not from a CDN.
  `frontend/public/razorsense` holds only the files of the default preset
  in both themes. Copy more from `@razorpay/blade/assets/spark` to use
  another preset.
