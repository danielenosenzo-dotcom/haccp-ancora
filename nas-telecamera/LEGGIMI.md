# Lettore temperature da telecamera — QNAP TS-251D

Legge i display delle celle inquadrati dalla telecamera Tapo e manda i valori
all'app HACCP. Gira sul NAS, che è sempre acceso e sulla stessa rete della
telecamera.

## Perché serve il NAS

La telecamera fa fotografie: non sa leggere i numeri né mandarli a nessuno.
Il flusso video è visibile **solo dalla rete del ristorante**, quindi né l'app
sul telefono né un servizio su internet possono raggiungerla. Il NAS è l'unico
pezzo già presente che sia sempre acceso e dentro quella rete.

## Cosa serve prima di iniziare

1. **Account telecamera Tapo** — nell'app Tapo: Impostazioni → Avanzate →
   Account telecamera. È diverso dal login Tapo. Serve per l'accesso RTSP.
2. **Indirizzo IP della telecamera** — si legge nell'app Tapo o nel pannello del router.
   Conviene fissarlo nel router (DHCP reservation) così non cambia.
3. **Chiave API Anthropic** — la stessa già usata per SpeakEasy.
4. **Credenziali Firebase** — dal file service account già scaricato.

## Installazione

### 1. Cartella di configurazione sul NAS

Crea la cartella `/share/Public/lettore-celle` e copiaci dentro
`config.esempio.json`, rinominandolo in `config.json`.

Compila i campi: IP e credenziali telecamera, chiave Anthropic, chiave privata
Firebase. **Il file resta solo sul NAS**: non entra nell'immagine del contenitore
e non va condiviso.

### 2. Avvio

Non serve copiare il programma sul NAS: Container Station lo prende da GitHub.

In Container Station → **Crea** → **Crea applicazione**, dai un nome
(`lettore-celle`) e incolla esattamente questo:

    services:
      lettore-celle:
        build: https://github.com/danielenosenzo-dotcom/haccp-ancora.git#main:nas-telecamera
        container_name: lettore-celle
        restart: unless-stopped
        environment:
          CONFIG_PATH: /config/config.json
        volumes:
          - /share/Public/lettore-celle:/config:ro

Poi avvia. La prima volta impiega qualche minuto: scarica e costruisce.

Per aggiornarlo in futuro basta ricostruire l'applicazione: riprende da GitHub
la versione aggiornata.

### 4. Verifica

Nei log del contenitore, entro un minuto, deve comparire qualcosa come:

    Lettore telecamera avviato — un giro ogni 60 minuti
    [07/08/2026, 14:00:12] lettura in corso
      Cella BT Cantina 1: -18.4°C [ok] certezza=alta
      Cella BT Cantina 2: -20.7°C [ok] certezza=alta
      completato

Poi apri l'app HACCP → TEMP: i valori devono essere quelli.

## Come si comporta quando non riesce a leggere

Se un display è appannato, coperto di brina, sfocato o ambiguo, la lettura viene
registrata come `lettura_fallita` e **non viene scritto alcun valore**.

Questa è una scelta deliberata: un registro HACCP con numeri inventati è peggio
di un registro con un buco. Il buco si vede e si spiega; un numero sbagliato no.

Il watchdog continua a sorvegliare: se le letture valide mancano troppo a lungo,
arriva la notifica.

## Taratura dell'inquadratura

La qualità della lettura dipende quasi interamente da quanto sono nitidi i
display nell'immagine. Se le letture risultano incerte:

- avvicina o zooma la telecamera sui quadranti
- raddrizza l'inquadratura: un display ripreso di taglio è molto più difficile
- verifica che nessun riflesso copra le cifre

Nel campo `posizione` di `config.json` si può descrivere meglio dove si trova
ciascun display (es. "in alto a destra, accanto al ventilatore"): aiuta a non
confonderli tra loro.

## Cosa succede alle vecchie sonde eWeLink

Vanno spente: leggevano con sei-otto gradi di errore e tenere due fonti
discordanti nello stesso registro è peggio che averne una sola affidabile.
Si disattiva il workflow `sync-temperature.yml` su GitHub quando questo
sistema è verificato e funzionante.
