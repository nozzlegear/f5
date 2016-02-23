#!/usr/bin/env node
var program = require("commander");
var glob = require("glob");
var fs = require("fs");
var cp = require("child_process");
var BBPromise = require("bluebird");
var path = require("path");
var spawn = require('cross-spawn-async');
process.on("exit", function () {
    console.log("");
    console.log("=======================================================================================");
    console.log("");
});
program
    .version("1.0.0")
    .option("restore", "Restores NuGet packages.")
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
var processConfig = {
    cwd: cwd,
    env: process.env
};
var executeBuild = function () { return new BBPromise(function (resolve, reject) {
    if (skipBuild) {
        resolve();
        return;
    }
    var build = cp.exec("msbuild \"" + solution + "\" /verbosity:m", processConfig, function (error) {
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
        resolve();
    });
    process.on("exit", function () {
        try {
            build.kill();
        }
        catch (e) {
        }
    });
}); };
var findStartupProjectPath = function () { return new BBPromise(function (resolve, reject) {
    if (solution.indexOf(".csproj") > -1) {
        resolve({
            Directory: path.parse(solution).dir,
            File: solution
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
        resolve({
            Directory: projectDirectory,
            File: projectFile
        });
    });
}); };
var restorePackages = function (location) { return new BBPromise(function (resolve, reject) {
    if (!shouldRestore) {
        resolve();
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
        resolve();
    });
    process.on("exit", function () {
        try {
            restore.kill();
        }
        catch (e) {
        }
    });
}); };
var host = function (location) {
    return new BBPromise(function (resolve, reject) {
        if (!shouldHost) {
            resolve();
            return;
        }
        ;
        console.log("Hosting project at %s", location.Directory);
        var host = spawn("iisexpress", [("/path:" + location.Directory), ("/port:" + port)], processConfig);
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
    });
};
var finchForward = function () {
    return new BBPromise(function (resolve, reject) {
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
    });
};
//Always restore packages first, because a build will fail without its packages
findStartupProjectPath().then(restorePackages).then(executeBuild).then(findStartupProjectPath).then(host).then(finchForward);
//# sourceMappingURL=f5.js.map