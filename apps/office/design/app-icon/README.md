# Argo Office app icons

Cabinet concept (option 03), rebuilt as an editable vector with the original Argo star path. The existing ivory background is retained; the stacked filing trays and central star are graphite black. The raster concept's photographic texture has been simplified for small-size rendering. The previous Workspace master is preserved as `office-workspace.svg`.

- `office.svg`: opaque full-square vector master, 1024 × 1024. The original Argo star path is uniformly scaled around its exact center.
- `office-macos.svg`: generated legacy macOS variant with transparent exterior, inset tile and soft shadow.
- `macOS/ArgoOffice.icns`: ten representations, 16/32/128/256/512 pt at 1x and 2x.
- `macOS/ArgoOffice.iconset`: source PNG representations, including 1024 px.
- `iOS/ArgoOffice-1024.png`: opaque RGB, full-square App Store/source PNG. Do not round the corners before importing.
- `iOS/Assets.xcassets/AppIcon.appiconset`: 18 explicit iPhone/iPad/App Store slots, with `Contents.json`.

This package uses the standard raster asset-catalog workflow. It is not a layered Icon Composer `.icon` package and does not include independently designed dark, tinted or clear variants.

Tauri's macOS bundle configuration points to the copied files in `src-tauri/icons/office/`. Existing icon files are preserved. The already-built review app is not modified by exporting these assets; rebuild it to embed the new icon. No iOS app target is created by this package.

The `macOS/` and `iOS/` export folders and the ZIP packages are build outputs and are not committed. Regenerate them from `apps/office` with `node scripts/build-app-icons.mjs`. Requires the repository's `sharp` dependency, `rsvg-convert` and macOS `iconutil`. If dependencies are in another checkout, set `SHARP_MODULE` to its installed `sharp` module path.

References: [Apple asset catalog configuration](https://developer.apple.com/documentation/xcode/configuring-your-app-icon), [App Icon Type slots](https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/AppIconType.html), [Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer).
