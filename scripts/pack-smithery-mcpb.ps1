$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $root "mcpb-build"
$output = Join-Path $root "server.smithery.mcpb"
$tempZip = Join-Path $root "server.smithery.zip"

if (-not (Test-Path -LiteralPath $buildDir)) {
    throw "mcpb-build not found. Run npm run mcpb:prepare:smithery first."
}

Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $buildDir "*") -DestinationPath $tempZip -CompressionLevel Optimal
Move-Item -LiteralPath $tempZip -Destination $output

"Packed Smithery MCPB bundle: $output"
