# rinha-2026-bun

Submissao Bun + Nginx para a Rinha de Backend 2026.

## Rodar local

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml --compatibility up -d --build --force-recreate
```

O endpoint exposto fica em `http://localhost:9999/fraud-score`.

## Dados

A imagem espera `resources/references.bin`, gerado a partir da base oficial no mesmo formato binario usado pela versao C.
