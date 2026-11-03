# Détecteur de cartes

Détecte l'**index** (valeur + couleur dans le coin) de chaque carte visible sur une
photo d'éventail. 32 classes (7 → As × ♠♥♦♣), index français (R/D/V) ou
internationaux (K/Q/J) indifféremment. Modèle YOLO nano → ONNX → navigateur.

## Entraîner

**Le plus rapide : Google Colab (GPU gratuit)**, ouvrir
[colab_train.ipynb](https://colab.research.google.com/github/hugohismans/cardcounter/blob/claude/adoring-gates-5by66o/detector/colab_train.ipynb)
et tout exécuter (~45 min).

**En local** (Python 3.10+, GPU NVIDIA ou Mac Apple Silicon conseillé) :

```bash
cd detector
python -m venv .venv && source .venv/bin/activate
pip install torch torchvision          # (Linux sans GPU : --index-url https://download.pytorch.org/whl/cpu)
pip install -r requirements.txt
./train_all.sh                          # EPOCHS=40 TRAIN=8000 ./train_all.sh pour changer
```

Le modèle est écrit dans `app/model/` (cards.onnx + meta.json).

## Étapes séparées

| Script | Rôle |
|---|---|
| `fetch_assets.py` | télécharge un jeu libre (SVG-cards, LGPL) |
| `prepare_deck.py` | transforme des photos de votre jeu en jeu utilisable |
| `synth.py` | génère les éventails synthétiques annotés (format YOLO) |
| `train.py` | entraîne (cuda / mps / cpu détecté automatiquement) |
| `export.py` | exporte en ONNX pour l'appli |
| `evaluate.py` | % de photos dont la liste de cartes est exacte |

## Ajouter votre jeu

Photos : une par couleur (`pique.jpg`, `coeur.jpg`, `carreau.jpg`, `trefle.jpg`),
les 8 cartes à plat dans l'ordre 7, 8, 9, 10, V, D, R, As, fond sombre uni, prise du dessus.

```bash
python prepare_deck.py --name mon_jeu photos/jeu_intl/*.jpg
# vérifier assets/decks/mon_jeu/_controle.jpg, puis régénérer les données et réentraîner
```
