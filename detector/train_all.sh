#!/usr/bin/env bash
# Pipeline complet : jeux de cartes -> données synthétiques -> entraînement -> export ONNX -> évaluation.
# Usage (depuis detector/) :  ./train_all.sh
#   variables : TRAIN VAL EPOCHS IMGSZ BATCH NAME
#               MODEL=chemin/best.pt pour affiner un modèle existant au lieu de partir de zéro
set -euo pipefail
cd "$(dirname "$0")"
TRAIN=${TRAIN:-6000}
VAL=${VAL:-500}
EPOCHS=${EPOCHS:-30}
IMGSZ=${IMGSZ:-640}
BATCH=${BATCH:-16}
NAME=${NAME:-cards}
MODEL=${MODEL:-yolo26n.pt}

[ -f assets/decks/svgcards/deck.json ] || python fetch_assets.py
# vos jeux photographiés : photos/jeu_<nom>/{pique,coeur,carreau,trefle}.jpg
for d in photos/jeu_*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ -f "assets/decks/$name/deck.json" ] || python prepare_deck.py --name "$name" "$d"*.jpg
done
[ -f data/synth/data.yaml ] || python synth.py --out data/synth --train "$TRAIN" --val "$VAL"
python train.py --model "$MODEL" --data data/synth/data.yaml --epochs "$EPOCHS" --imgsz "$IMGSZ" --batch "$BATCH" --name "$NAME"
python export.py "runs/$NAME/weights/best.pt" --imgsz "$IMGSZ"
echo; echo "=== Données synthétiques (validation) ==="
python evaluate.py "runs/$NAME/weights/best.pt" data/synth/images/val --limit 300 | tail -6
if ls photos/test/*.jpg >/dev/null 2>&1; then
  echo; echo "=== Vraies photos (photos/test) ==="
  python evaluate.py "runs/$NAME/weights/best.pt" photos/test --save "runs/$NAME/test_photos"
fi
echo
echo "Modèle prêt : ../app/model/cards.onnx (+ meta.json)."
