# data/scripts

One-off processing scripts go here (e.g. downloading DEMs, computing slope,
cutting danger tiles into `data/tiles/`).

Large inputs and outputs (`data/raw/`, `data/processed/`, `*.tif`, `*.npy`)
are never committed, so every derived file must be reproducible by running
the scripts in this folder. Document the order to run them in this README.
