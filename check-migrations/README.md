# Black action

Run Black and add

## Inputs

### `github-token`

**Required** The GitHub API token.

## Example usage

```yml
name: Black
uses: ljodal/python-actions/black@master
with:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  max-errors: 0
```
