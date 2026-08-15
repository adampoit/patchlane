{
  description = "Patchlane development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    systems = ["aarch64-darwin" "x86_64-linux"];
    forAllSystems = function:
      builtins.listToAttrs (map (system: {
          name = system;
          value = function (import nixpkgs {inherit system;});
        })
        systems);
  in {
    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          git
          gh
          jujutsu
          nodejs_24
        ];
      };
    });
  };
}
