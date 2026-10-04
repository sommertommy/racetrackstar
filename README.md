# RaceTrackstar

Mobile-first webapp til RC-ræs: opret dine biler med billede og navn, definér løbstyper, og kør løb hvor telefonens kamera tracker bilerne rundt på banen og tæller omgange, når de krydser mållinjen. Alle løb gemmes i historikken.

## Sådan bruger du den

1. **Garage** – tilføj biler med foto og navn. Tryk på bilens lak i fotoet for at sætte dens tracking-farve.
2. **Løbstyper** – opret formater: antal omgange eller tid, min. omgangstid (filtrerer dobbelt-tællinger), flyvende/stående start, kamera- eller manuel tidtagning.
3. **Ræs** – vælg løbstype og biler. Stil telefonen stabilt med udsyn til mållinjen (gerne lidt over banen, fx på et stativ), træk mållinjen med fingeren, tryk på hver bil i billedet for at kalibrere dens farve, og start.
4. **Historik** – alle løb gemmes med placeringer, omgangstider og bedste omgang.

Under løbet kan du altid trykke **+1** / **↶** på en bil, hvis trackingen misser en passage.

## Tracking

YOLOv8n kører direkte i browseren (onnxruntime-web, lokalt i `vendor/ort/`) og finder bilerne i hvert billede. Identiteten (hvilken bil er hvilken) styres af tre regler:

1. **Bevægelse først:** en synlig bil følges fra billede til billede på sin position og fart, ikke på farve.
2. **Én bil væk:** er præcis én bil forsvundet (bag en bakke, ud af billedet), antages det, at den næste nye bil, der dukker op, er den.
3. **Flere biler væk:** er flere væk samtidig, afgør farven i YOLO-boksen, hvem der er hvem. Det samme gælder, når to biler har overlappet hinanden (overhaling eller sammenstød) og skilles igen.

Ting YOLO ser, som står stille og ikke er biler (kegler, kasser, sko), lærer den at ignorere. Det sker ved start og løbende under løbet.

- **Præcis / Hurtig:** Præcis (640 px) finder også små biler langt væk. Hurtig (320 px) er cirka 4 gange hurtigere, men ser først biler, når de fylder meget i billedet. Vælg Hurtig, hvis telefonen er tæt på banen eller er langsom.
- **Følsomhed:** sænk den, hvis YOLO ikke ser dine biler. Hæv den, hvis den ser ting, der ikke er biler.
- **Lysspor:** hver bil trækker et glødende spor i sin egen farve. Længden sættes pr. løbstype (0 = slukket).
- **Find bilerne:** tryk på hver bils boks inden start. Det giver den sikreste start. Springer du det over, finder appen bilerne på deres garagefarve.

YOLO er trænet på almindelige fotos (COCO), ikke RC-biler. Mange RC-biler genkendes som "car" eller "truck", men ikke alle. Test derfor på din egen bane. Kan YOLO slet ikke køre på telefonen, skifter appen automatisk til ren farvetracking. **+1 / ↶** virker altid som backup.

Data gemmes lokalt på enheden (IndexedDB) – ingen konto, ingen server.

## Kør lokalt (test på telefonen)

Kameraet kræver HTTPS, så der følger en lille HTTPS-server med (selvsigneret certifikat ligger i `certs/`):

```
node server.js
```

Åbn derefter den viste `https://<din-pc-ip>:8443` på telefonen (samme wifi) og acceptér certifikat-advarslen ("Avanceret" → "Fortsæt").

## Læg den på nettet (anbefalet til daglig brug)

Appen er 100 % statisk – hele mappen kan hostes hvor som helst med HTTPS:

- **GitHub Pages**: push mappen til et repo → Settings → Pages → deploy fra `main`. 
- **Netlify**: træk mappen ind på [app.netlify.com/drop](https://app.netlify.com/drop).

Derefter kan du åbne appen på telefonen og vælge "Føj til hjemmeskærm", så den kører i fuld skærm som en app (og virker offline via service worker).

## Tips til god tracking

- Fast kameraposition: telefon på stativ, hele mållinje-området i billedet.
- God, jævn belysning uden hårde skygger ved mållinjen.
- Klare, forskellige farver pr. bil (orange, grøn, blå, pink tape virker godt). Farven bruges kun, når bevægelsen ikke kan afgøre det, men så er den afgørende.
- Kameraet lidt oppe og skråt ned over banen. YOLO genkender biler bedst lidt fra siden, ikke lige oppefra.
- Sæt "Min. omgangstid" tæt på din reelt hurtigste omgang minus et par sekunder – det fjerner dobbelt-tællinger, når en bil holder stille på linjen.
