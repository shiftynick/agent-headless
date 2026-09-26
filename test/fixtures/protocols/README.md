# Provider protocol contracts

`v1/manifest.json` versions the fixture format and lists provider streams with
expected normalized outcomes. These fixtures are synthetic, sanitized examples
based on the adapter contracts and published CLI documentation, not transcripts
from authenticated sessions. They contain no credentials or private prompts.

The fixture suite covers all four providers: success, incomplete output, and a
provider error after an apparent success. Claude's schema fixture also covers
`structured_output` with an empty text result.

When a provider changes its event format, retain the old fixture and add a new
case/revision. Record the originating CLI version when importing a sanitized
real transcript. Only describe an output as captured when it actually was.

`help/` contains read-only CLI help captured from the installed versions named
in the filenames. Capability tests replay these snapshots to verify optional
feature discovery. Re-capture these with `--help`; never run paid prompts just
to regenerate the help fixtures.
