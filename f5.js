#!/usr/bin/env node
"use strict";
var program = require("commander");
var glob = require("glob");
var fs = require("fs");
var cp = require("child_process");
var BBPromise = require("bluebird");
var path = require("path");
var parseXml = require("xml-parser");
var lodash_1 = require("lodash");
var spawn = require('cross-spawn-async');
process.on("exit", function () {
    console.log("");
    console.log("=======================================================================================");
    console.log("");
});
program
    .version("1.0.0")
    .option("restore", "Restores NuGet packages.")
    .option("--newMigration [newMigrationName]", "Creates a new EF migration")
    .option("--targetMigration [targetMigration]", "Upgrades or downgrades the database to the given target migration")
    .option("-s, --solution [solution]", "Solution File")
    .option("-p, --port [port]", "Port")
    .option("-i, --iis", "IIS Hosting")
    .option("-f, --finchname [finchName]", "Finch Forward site name")
    .option("-n, --nobuild", "Skip the build command")
    .usage("f5 -s 'MyApp/Solution.sln' -f Finchname -i")
    .parse(process.argv);
console.log("");
console.log("=======================================================================================");
console.log("");
var port = program["port"] || 62211;
var shouldHost = program["iis"];
var finchName = program["finchName"];
var skipBuild = program["noBuild"];
var cwd = process.cwd();
var shouldRestore = program["restore"];
var newMigrationName = program["newMigration"];
var targetMigration = program["targetMigration"];
var solution = program["solution"];
if (!solution) {
    console.log("No solution or .csproj file specified, looking for a solution or project file in %s", cwd);
    var solutions = glob.sync(cwd + "/*.sln", { nodir: true });
    var csprojs = glob.sync(cwd + "/*.csproj", { nodir: true });
    var files = solutions.concat(csprojs);
    if (files.length === 0) {
        console.error("ERROR: No solution or .csproj file found in " + cwd + ".");
        process.exit();
    }
    solution = files[0];
}
var F5;
(function (F5) {
    function start() {
        //Always restore packages first, because a build will fail without its packages
        findStartupProjectPath()
            .then(restorePackages)
            .then(executeBuild)
            .then(createMigration)
            .then(restoreMigration)
            .then(host)
            .then(finchForward);
    }
    F5.start = start;
    var processConfig = {
        cwd: cwd,
        env: process.env
    };
    var findAssembly = function (location) { return new BBPromise(function (resolve, reject) {
        //Find the path to the assembly (.dll file)
        fs.readFile(location.File, { encoding: "utf8" }, function (error, data) {
            var xml = parseXml(data);
            var propGroups = lodash_1.filter(xml.root.children, function (node) { return node.name === "PropertyGroup" && lodash_1.some(node.children, function (child) { return child.name === "AssemblyName"; }); });
            var assemblyName = lodash_1.find(propGroups[0].children, function (node) { return node.name === "AssemblyName"; });
            resolve(path.join(location.Directory, "bin", assemblyName.content + ".dll"));
        });
    }); };
    var findStartupProjectPath = function () { return new BBPromise(function (resolve, reject) {
        if (solution.indexOf(".csproj") > -1) {
            var output_1 = {
                Directory: path.parse(solution).dir,
                File: solution,
                AssemblyFile: undefined
            };
            findAssembly(output_1).then(function (assemblyFile) {
                output_1.AssemblyFile = assemblyFile;
                resolve(output_1);
            });
            return;
        }
        //Startup projects are listed as the first *.csproj in a solution file.
        fs.readFile(solution, { encoding: "utf8" }, function (error, data) {
            //Find the string containing the first project. It looks like "Path/To/ProjectName.csproj" with quote marks;
            var solutionDir = path.parse(solution).dir;
            var csprojIndex = data.indexOf(".csproj\"");
            var pathString = data.substring(0, csprojIndex + ".csproj".length);
            var quoteIndex = pathString.lastIndexOf("\"");
            //Get the path between the first quote mark and .csproj
            pathString = pathString.substr(quoteIndex + 1);
            var projectDirectory = path.join(solutionDir, path.parse(pathString).dir);
            var projectFile = path.join(solutionDir, pathString);
            var output = {
                Directory: projectDirectory,
                AssemblyFile: undefined,
                File: projectFile,
            };
            findAssembly(output).then(function (assemblyFile) {
                output.AssemblyFile = assemblyFile;
                resolve(output);
            });
            resolve(output);
        });
    }); };
    var executeBuild = function (location) { return new BBPromise(function (resolve, reject) {
        if (skipBuild) {
            resolve(location);
            return;
        }
        var build = cp.exec("msbuild \"" + location.File + "\" /verbosity:m", processConfig, function (error) {
            if (error) {
                console.log("");
                console.error(error.message);
                console.log("");
                process.exit();
                reject(error.message);
            }
            ;
        });
        build.stderr.on("data", function (error) {
            process.stderr.write(error);
        });
        build.stdout.on("data", function (data) {
            process.stdout.write(data);
        });
        build.on("exit", function () {
            resolve(location);
        });
        process.on("exit", function () {
            try {
                build.kill();
            }
            catch (e) {
            }
        });
    }); };
    var createMigration = function (location) { return new BBPromise(function (resolve, reject) {
        if (!newMigrationName) {
            resolve(location);
            return;
        }
        console.log("Creating target migration.", newMigrationName);
        var replaceSplashes = function (str) {
            while (str.indexOf("\\") > -1) {
                str = str.replace("\\", "/");
            }
            return str;
        };
        var webConfigPath = path.join(location.Directory, "web.config");
        var exePath = path.join(__dirname, "/bin/EntityFramework.6.1.3/tools/migrate.exe");
        var command = replaceSplashes(exePath + " \"" + location.AssemblyFile + "\" /startupConfigurationFile=\"" + webConfigPath + "\"");
        console.log("Migration command: ", command);
        var migrate = cp.exec(command);
        migrate.stderr.on("data", function (error) {
            process.stderr.write(error);
        });
        migrate.stdout.on("data", function (data) {
            process.stdout.write(data);
        });
        migrate.on("exit", function () {
            resolve(location);
        });
        process.on("exit", function () {
            try {
                migrate.kill();
            }
            catch (e) {
            }
        });
        resolve(location);
    }); };
    var restoreMigration = function (location) { return new BBPromise(function (resolve, reject) {
        if (!targetMigration) {
            resolve(location);
            return;
        }
    }); };
    var restorePackages = function (location) { return new BBPromise(function (resolve, reject) {
        if (!shouldRestore) {
            resolve(location);
            return;
        }
        //Assume there's a packages.config file in the project file's directory, and 
        //that packages directory is one level above .csproj directory.
        var packagesDirectory = path.join(location.Directory, "../packages");
        var configFile = path.join(location.Directory, "packages.config");
        console.log("Restoring packages to %s", packagesDirectory);
        var restore = cp.exec("nuget restore -outputdirectory \"" + packagesDirectory + "\" -configfile \"" + configFile + "\"", processConfig, function (error) {
            if (error) {
                console.log("");
                console.error(error.message);
                console.log("");
                process.exit();
                reject(error.message);
            }
            ;
        });
        restore.stderr.on("data", function (error) {
            process.stderr.write(error);
        });
        restore.stdout.on("data", function (data) {
            process.stdout.write(data);
        });
        restore.on("exit", function () {
            resolve(location);
        });
        process.on("exit", function () {
            try {
                restore.kill();
            }
            catch (e) {
            }
        });
    }); };
    var host = function (location) { return new BBPromise(function (resolve, reject) {
        if (!shouldHost) {
            resolve();
            return;
        }
        ;
        //IIS requires the path to use backslashes rather than forward slashes. Using backslashes 
        //will make IIS throw 404s on any requested URL.
        var directory = location.Directory.split("/").join("\\");
        console.log("Hosting project at %s", directory);
        var host = spawn("iisexpress", [("/path:" + directory), ("/port:" + port)], processConfig);
        host.stderr.on("data", function (error) {
            process.stderr.write(error);
            process.exit();
        });
        host.stdout.on("data", function (data) {
            if (data.indexOf("IIS Express is running.") > -1) {
                resolve();
            }
            if (data.indexOf("Enter 'Q' to stop IIS Express") === -1) {
                process.stdout.write(data);
            }
        });
        host.on("exit", function () {
            process.exit();
        });
        process.on("exit", function () {
            try {
                host.stdin.write("q", "utf8");
                host.kill("SIGINT");
            }
            catch (e) {
            }
        });
    }); };
    var finchForward = function () { return new BBPromise(function (resolve, reject) {
        if (!shouldHost || !finchName) {
            resolve();
            return;
        }
        console.log("Forwarding port " + port + " to Finch site " + finchName);
        var forward = spawn("finch", ["forward", "--name", ("" + finchName)], processConfig);
        forward.stdout.on("data", function (data) {
            if (data.indexOf("one or more subdomains are currently in use") > -1) {
                console.log("Finch host still in use, skipping startup.");
                console.log("Note: Finch host may be killed at any time, command line is unable to force restart.");
                console.log("Enter 'Q' to stop IIS Express");
                return;
            }
            process.stdout.write(data);
        });
        forward.on("exit", function () {
            resolve();
        });
        process.on("exit", function () {
            try {
                //Send CTRL+C to Finch command line to cancel forward.
                forward.stdin["write"](null, { control: true, name: "c" });
                forward.kill("SIGINT");
            }
            catch (e) {
                //Swallow
                if (e.code !== "EPIPE") {
                    console.log("Could not stop Finch.", e);
                }
                ;
            }
        });
    }); };
})(F5 = exports.F5 || (exports.F5 = {}));
F5.start();
//# sourceMappingURL=f5.js.map