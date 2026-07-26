# Changelog

## [0.2.0](https://github.com/dibenkobit/sidder/compare/v0.1.0...v0.2.0) (2026-07-26)


### Features

* **cli:** add command-specific help ([df284ee](https://github.com/dibenkobit/sidder/commit/df284ee8a7bce25efa1430a5913524b14aea452b))
* **docs:** rebuild homepage as a seed operation register ([af87e56](https://github.com/dibenkobit/sidder/commit/af87e56d4d44cb2aa87a1607b1f07e0cb1c7940d))
* **docs:** scaffold fumadocs site ([cf56d40](https://github.com/dibenkobit/sidder/commit/cf56d40bb94f89b5b84a85620b529c9b7af0bade))


### Bug Fixes

* **init:** generate module-safe starter files ([18f74d8](https://github.com/dibenkobit/sidder/commit/18f74d8179157ad6f8c482cff40462fd953476ac))
* **init:** show type-safe seed examples ([76d3745](https://github.com/dibenkobit/sidder/commit/76d3745f180c3ca6e332f3b075f595408c253279))
* **run:** keep dry runs read-only ([fdca467](https://github.com/dibenkobit/sidder/commit/fdca4670d8f1fc06349da2b822207eea4fadd75b))


### Reverts

* **docs:** restore original landing page ([456f9af](https://github.com/dibenkobit/sidder/commit/456f9af838e4c3c114aedab7983b3f82a4001c64))

## [0.1.0](https://github.com/dibenkobit/sidder/compare/v0.0.1...v0.1.0) (2026-07-26)


### Features

* add seed runner with journal, dependency order and env gates ([517446a](https://github.com/dibenkobit/sidder/commit/517446a620f86659a460b04e7ac0899436d9ce3c))
* **cli:** add --force and forget for re-running an applied seed ([8613f67](https://github.com/dibenkobit/sidder/commit/8613f672b72e92a8b446824cf81ff7d849eb4429))
* **cross-imports:** warn when one seed imports another ([cf94ffa](https://github.com/dibenkobit/sidder/commit/cf94ffa5d0e4728a54f5824984744c449c273125))
* **discover:** find seed files that import each other ([7cbbfcf](https://github.com/dibenkobit/sidder/commit/7cbbfcf6f4c73d758b2e2205604920e3cef85ea6))
* **errors:** answer an import that does not resolve ([2401b41](https://github.com/dibenkobit/sidder/commit/2401b413e355dbd4ffe460141a30f5578e351c63))
* say when a run is waiting, and what no transaction costs ([7752c28](https://github.com/dibenkobit/sidder/commit/7752c28ed02bc87c70edbc92c6b3f6722006ac80))


### Bug Fixes

* **cli:** collapse --only skips and warn on an unknown env ([b7716ee](https://github.com/dibenkobit/sidder/commit/b7716ee069567ef76ec57fc3aa073efeb283440a))
* **cli:** honour FORCE_COLOR and trim trailing space from status ([b6713bd](https://github.com/dibenkobit/sidder/commit/b6713bd74c5f310b606f571ba09a51ea21c130de))
* **journal:** name the table and the setting when it is not a journal ([23e7051](https://github.com/dibenkobit/sidder/commit/23e7051541203cff58b33c4f9f70e6470252c10a))
* **loader:** tell a module that did not compile from one that threw ([cefa0be](https://github.com/dibenkobit/sidder/commit/cefa0bec252827587175a11692eec5bbd5557bdc))
* **run:** report what a run did, not what it decided ([fc404f8](https://github.com/dibenkobit/sidder/commit/fc404f876ed7be92f8eb719af3bc2bb24eb4fa24))
* **run:** stop two concurrent runs applying the same seed twice ([259497f](https://github.com/dibenkobit/sidder/commit/259497f1aaadaf11b6b08f913a64f1553e9700a5))
