# Dump database

Run migrations and dump the resulting database. Useful to speed up test runs.

## Inputs

### `github-token`

**Required** The GitHub API token.

## Example usage

```yml
name: Dump database
uses: ljodal/django-actions/dump-database@feature/dump-database
with:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  output-path: 'path/to/file.sql'
  branch: 'tweak/update-db-dump'
  db-name: 'postgres'
  db-user: 'postgres'
  db-host: 'localhost'
  db-port: ${{ services.postgres.ports[5432] }}
  db-pass: 'postgres'
```
