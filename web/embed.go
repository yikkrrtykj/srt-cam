package webassets

import "embed"

// Dist holds the compiled TypeScript frontend bundle embedded into the single srt-camd binary.
//
//go:embed all:dist
var Dist embed.FS
