# Meta Mock Camera Fixtures

These synthetic, non-production videos are source-controlled test inputs for
the Meta Wearables Device Access Toolkit camera boundary. They are excluded
from the shipping app bundle.

- `meta_mock_gs1_datamatrix.mp4` contains one GS1 DataMatrix carrying GTIN
  `00012345678905`, expiry `271231`, lot `LOT42`, and serial `SER0001`.
- `meta_mock_code128_leading_zero.mp4` contains one Code 128 value,
  `000123456789`, to prove leading zeroes survive the camera boundary.
- `meta_mock_ambiguous.mp4` contains both symbols in one frame and must not
  produce a scanner observation.
- `meta_mock_delayed_code128.mp4` is blank before showing the Code 128 value;
  it preserves a delayed-frame input for the physical/simulator pilot.

The raster symbols were generated with `bwip-js` 4.6.0 and converted to small
H.264/yuv420p videos with FFmpeg. `Tools/verify-meta-mock-fixtures.swift`
decodes the committed fixtures with Apple Vision and checks their exact
contents in the Phase 1 validation gate.
