# Is deze vraag al een keer beantwoord?

Een zoekwebsite om snel eerdere antwoorden op Kamervragen, Kamerbrieven, nota's naar aanleiding van het verslag en debatten over belastingen terug te vinden. Je plakt een (nieuwe) Kamervraag of typt een paar steekwoorden, en de site laat de best passende vraag-en-antwoordpassages zien. Elke passage heeft een bronvermelding en een link naar het officiële document.

## Hoe het werkt

- **Bron:** de open data van [officielebekendmakingen.nl](https://zoek.officielebekendmakingen.nl) (KOOP). Daarin staan alle Kamerstukken, Aanhangsels van de Handelingen (de antwoorden op Kamervragen) en Handelingen. De site zoekt live, dus nieuwe stukken zijn meteen vindbaar.
- **Standaardfilter:** onderwerp *Financiën | Belasting*, vanaf 2018. Dit is aan te passen onder "Filters".
- **Slim zoeken:**
  1. De site haalt de belangrijke woorden uit de vraag. Woorden als "de leden van de fractie vragen", namen van Kamerleden en partijnamen vallen weg.
  2. Hij zoekt ook op synoniemen en schrijfvarianten (zie `js/synoniemen.js`), bijvoorbeeld crypto, cryptovaluta en crypto-activa.
  3. Hij zoekt de documenten waarin de meeste en zeldzaamste termen samen voorkomen.
  4. Die documenten worden opgehaald en opgedeeld in passages (vraag + antwoord, of alinea's onder een kopje).
  5. De passages worden op relevantie gerangschikt.
- **Conceptantwoord:** vink passages aan als bron en klik op *Kopieer prompt voor AI-chatbot*. De Kamervraag, je eigen prompt en de bronnen (met vindplaats) gaan dan naar het klembord. Je kunt ze plakken in de AI-chatbot die je organisatie toestaat. Je eigen prompt stel je in onder *Mijn prompt instellen*. Die wordt alleen in je eigen browser bewaard.
- **Links delen:** de zoekvraag staat in de adresbalk (`?q=…`), dus je kunt een zoekopdracht doorsturen naar een collega.

Er is geen server en geen database nodig. Alles draait in de browser, en er wordt niets opgeslagen of verstuurd behalve de zoekopdrachten naar officielebekendmakingen.nl.

## Synoniemen aanvullen

Open `js/synoniemen.js` en voeg een regel toe, bijvoorbeeld:

```js
["box 2", "aanmerkelijk belang", "ab-heffing"],
```

Gebruik kleine letters en geen accenten. Na het opslaan (commit) is de aanpassing binnen een minuut online.

## Online zetten met GitHub Pages

1. Zet deze bestanden in een GitHub-repository.
2. Ga in de repository naar **Settings → Pages**.
3. Kies bij *Source*: **Deploy from a branch**, branch **main**, map **/ (root)**, en klik op *Save*.
4. Na ongeveer een minuut staat de site op `https://<gebruikersnaam>.github.io/<repository-naam>/`.

## Inloggen

GitHub Pages kan zelf geen login afdwingen. Omdat de site alleen openbare stukken toont en niets opslaat, is dat voor deze versie geen probleem. Wil je toch dat alleen je team erbij kan, zet de site dan op **Cloudflare Pages** (gratis), gekoppeld aan deze GitHub-repository. Met **Cloudflare Access** (gratis tot 50 gebruikers) loggen teamleden dan in met een eenmalige code per e-mail. Een login is wel nodig zodra de site zelf een AI-dienst gaat aanroepen, omdat er dan kosten per gebruik zijn.

## Zelf testen

Je kunt de site lokaal draaien met een eenvoudige webserver:

```bash
python3 -m http.server 8000
```

Open daarna http://localhost:8000. De zoeklogica kun je ook los testen met Node 22 of nieuwer:

```bash
node test/voorbeelden.mjs
```

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De pagina |
| `css/style.css` | Opmaak (ondersteunt ook donkere modus) |
| `js/app.js` | Gebruikersinterface: resultaten, selectie, prompt kopiëren |
| `js/search.js` | Zoeklogica: termen bepalen, zoekdienst bevragen, passages rangschikken |
| `js/synoniemen.js` | Synoniemenlijst (zelf aan te vullen) |
| `test/` | Testscripts met voorbeeldvragen |
