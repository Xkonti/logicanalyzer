param (
    [Parameter(Mandatory=$true)]
    [string]$packageVersion
)

$packageName = "logicanalyzer_" + $packageVersion

# Paths from settings.json
$cmakePath = "${env:USERPROFILE}/.pico-sdk/cmake/v3.31.5/bin/cmake"
$cmakeBinPath = "${env:USERPROFILE}/.pico-sdk/cmake/v3.31.5/bin/cmake"
$ninjaPath = "${env:USERPROFILE}/.pico-sdk/ninja/v1.12.1"
$picoSdkPath = "${env:USERPROFILE}/.pico-sdk/sdk/2.1.1"
$picoToolchainPath = "${env:USERPROFILE}/.pico-sdk/toolchain/14_2_Rel1"
$picoToolchainBinPath = "${env:USERPROFILE}/.pico-sdk/toolchain/14_2_Rel1/bin"
$picoToolPath = "${env:USERPROFILE}/.pico-sdk/picotool/2.1.1/picotool"

# Get the number of processors
$processorCount = [Environment]::ProcessorCount

# Create the publish directory if it doesn't exist
$publishDir = ".\publish"
if (-Not (Test-Path -Path $publishDir)) {
    New-Item -ItemType Directory -Path $publishDir
} else {
    # Clear the publish directory
    Remove-Item -Recurse -Force "$publishDir\*"
}

# Set environment variables
$env:PICO_SDK_PATH = $picoSdkPath
$env:PICO_TOOLCHAIN_PATH = $picoToolchainPath

# Add paths to $env:Path only if they are not already set
$pathsToAdd = @($picoToolchainBinPath, $picoToolPath, $cmakeBinPath, $ninjaPath)
foreach ($path in $pathsToAdd) {
    if (-not ($path -in ($env:Path -split ";" | ForEach-Object { $_.Trim() }))) {
        $env:Path = "$path;$env:Path"
    }
}

# Build for Pico 2W WiFi (the only supported board)
Remove-Item -Recurse -Force "build"
New-Item -ItemType Directory -Path "build"
Set-Location -Path "build"

# Run the CMake configuration command
& $cmakePath -G "Ninja" ..

# Run the CMake build command
& $cmakePath --build . --config Release -- -j $processorCount

# Check if the .uf2 file exists before moving it
$uf2File = "LogicAnalyzer.uf2"
if (Test-Path -Path $uf2File) {
    $binaryName = "${packageName}.uf2"
    Move-Item -Path $uf2File -Destination "..\$publishDir\$binaryName"
} else {
    Write-Host "Error: $uf2File not found"
}

# Return to the root directory
Set-Location -Path ".."

# Compress the .uf2 file and delete the original
Get-ChildItem -Path $publishDir -Filter *.uf2 | ForEach-Object {
    $zipFileName = "$($_.BaseName).zip"
    Compress-Archive -Path $_.FullName -DestinationPath "$publishDir\$zipFileName"
    Remove-Item -Path $_.FullName
}
