## npm-bisect

Highly experimental tool to help locate a regression in a project caused by a
new version of a direct or indirect dependency. Insipred by `git bisect`.

### Installation

npm install -g npm-bisect

### Usage

```
Options:
  --help     Show help                                                 [boolean]
  --version  Show version number                                       [boolean]
  --debug    Produce verbose output for each step     [boolean] [default: false]
  --yarn     Use yarn instead of npm                  [boolean] [default: false]
  --run      Shell command to run for each step. Will use interactive mode if
             not given                                                  [string]
  --ignore   Name of a package to ignore. Can be repeated  [array] [default: []]
  --good     Date or datetime where the project was last known to work  [string]
  --bad      Date or datetime where the project was first found broken  [string]
```
