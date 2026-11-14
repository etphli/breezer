# Frame-budget preparation fixture

These three Chromium/Helium base files match the before hashes in
`features/performance/frame-budget/pins.json`. They are retained source inputs
from the original frame-budget integration fixture for Chromium 156.0.8078.47.
Original copyright headers and the Chromium BSD license are preserved.

The checker applies the actual preparer to disposable copies and tests rejection,
interruption/retry, source preservation and the build wrapper gates. It does not
compile Chromium, run the C++ unit cases or establish rendering/performance.

```sh
python3 -B script/check_breezer_frame_budget.py \
  --fixture-source tests/fixtures/frame-budget/base \
  --work-dir build/frame-budget-fixture-check
```
