GEAR SHOP IMAGES
================

Drop character images in THIS folder (jpg, png, or gif), then list the filename
in ../characters.json. The name shown in the shop is the filename without its
extension:

    Character1.jpg        -> "Character1"
    Sonic the hero.gif    -> "Sonic the hero"

Character1/2/3.jpg here are placeholders — replace them with real art any time.
Every character costs the same (costPerCharacter in characters.json, default 200
coins). To charge a different price for one, use the object form in that file:

    { "file": "Sonic the hero.gif", "cost": 350 }

Square images (roughly 240x240 or larger) look best; they're shown in a circle.
