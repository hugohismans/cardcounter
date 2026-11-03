#!/usr/bin/env bash
# Pipeline complet : jeu libre -> données synthétiques -> entraînement -> export ONNX.
# Usage (depuis detector/) :  ./train_all.sh            (valeurs par défaut)
#                             EPOCHS=40 TRAIN=8000 ./train_all.sh
set -euo pipefail
cd "$(dirname "$0")"
TRAIN=${TRAIN:-6000}
VAL=${VAL:-500}
EPOCHS=${EPOCHS:-30}
IMGSZ=${IMGSZ:-640}
BATCH=${BATCH:-16}
NAME=${NAME:-cards}

[ -f assets/decks/svgcards/deck.json ] || python fetch_assets.py
[ -f data/synth/data.yaml ] || python synth.py --out data/synth --train "$TRAIN" --val "$VAL"
python train.py --data data/synth/data.yaml --epochs "$EPOCHS" --imgsz "$IMGSZ" --batch "$BATCH" --name "$NAME"
python export.py "runs/$NAME/weights/best.pt" --imgsz "$IMGSZ"
python evaluate.py "runs/$NAME/weights/best.pt" data/synth/images/val --limit 300 | tail -8
echo
echo "Modèle prêt : ../app/model/cards.onnx (+ meta.json)."
echo "Envoyez ces deux fichiers sur la branche (dossier app/model/) ou commitez-les."
