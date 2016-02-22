#!/usr/bin/env node
/// <reference path="./typings/tsd.d.ts" />

import * as program from "commander";
import * as glob from "glob";
import * as fs from "fs";
import * as cp from "child_process";
import * as BBPromise from "bluebird";
import * as path from "path";
import spawn = require('cross-spawn-async');

process.on("exit", () => 
{
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

const port = program["port"] || 62211;
const shouldHost: boolean = program["iis"];
const finchName: string = program["finchName"];
const skipBuild: boolean = program["noBuild"];
const cwd = process.cwd();
const shouldRestore= program["restore"];
let solution: string = program["solution"];

if (!solution) 
{
    console.log("No solution or .csproj file specified, looking for a solution or project file in %s", cwd);

    let solutions = glob.sync(cwd + "/*.sln", {nodir: true});
    let csprojs = glob.sync(cwd + "/*.csproj", {nodir: true});
    let files = solutions.concat(csprojs);
    
    if (files.length === 0) 
    {
        console.error(`ERROR: No solution or .csproj file found in ${cwd}.`);

        process.exit();
    }

    solution = files[0];
}

const processConfig = 
{
    cwd: cwd,
    env: process.env
};

const executeBuild = () =>  new BBPromise<void>((resolve, reject) => 
{
    if(skipBuild)
    {
        resolve();
        
        return;
    }
    
    const build = cp.exec(`msbuild "${solution}" /verbosity:m`, processConfig, (error) => 
    {
        if (error) 
        {
            console.log("");
            console.error(error.message);
            console.log("");

            process.exit();

            reject(error.message);
        };
    });

    build.stderr.on("data", (error) => 
    {
        process.stderr.write(error);
    })

    build.stdout.on("data", (data) => 
    {
        process.stdout.write(data);
    })

    build.on("exit", () => 
    {
        resolve();
    });

    process.on("exit", () => 
    {
        try {
            build.kill();
        }
        catch (e) {
            //Swallow
        }
    });
});

const findStartupProjectPath = () =>  new BBPromise<{Directory: string; File: string;}>((resolve, reject) => 
{    
    if(solution.indexOf(".csproj") > -1)
    {
        resolve({
            Directory: path.parse(solution).dir,
            File: solution
        });
        
        return;
    }
    
    //Startup projects are listed as the first *.csproj in a solution file.
    fs.readFile(solution, { encoding: "utf8" }, (error, data) => 
    {
        //Find the string containing the first project. It looks like "Path/To/ProjectName.csproj" with quote marks;
        let solutionDir = path.parse(solution).dir;
        let csprojIndex = data.indexOf(".csproj\"");
        let pathString = data.substring(0, csprojIndex + ".csproj".length);
        let quoteIndex = pathString.lastIndexOf("\"");
        
        //Get the path between the first quote mark and .csproj
        pathString = pathString.substr(quoteIndex + 1);
        
        const projectDirectory = path.join(solutionDir, path.parse(pathString).dir);
        const projectFile = path.join(solutionDir, pathString); 

        resolve({
            Directory: projectDirectory,
            File: projectFile
        });
    });
});

const restorePackages = (location: {Directory: string; File: string;}) => new BBPromise<void>((resolve, reject) =>
{
    if(!shouldRestore)
    {
        resolve();
        
        return;
    }
    
    //Assume there's a packages.config file in the project file's directory, and 
    //that packages directory is one level above .csproj directory.
    const packagesDirectory = path.join(location.Directory, "../packages");
    const configFile = path.join(location.Directory, "packages.config"); 
     
    console.log("Restoring packages to %s", packagesDirectory);
    
    const restore = cp.exec(`nuget restore -outputdirectory '${packagesDirectory}' -configfile '${configFile}'`, processConfig, (error) =>
    {
        if (error) 
        {
            console.log("");
            console.error(error.message);
            console.log("");

            process.exit();

            reject(error.message);
        };
    });
    
    restore.stderr.on("data", (error) => 
    {
        process.stderr.write(error);
    })

    restore.stdout.on("data", (data) => 
    {
        process.stdout.write(data);
    })

    restore.on("exit", () => 
    {
        resolve();
    });

    process.on("exit", () => 
    {
        try {
            restore.kill();
        }
        catch (e) {
            //Swallow
        }
    });
});

const host = (location: {Directory: string; File: string;}) => 
{
    return new BBPromise<void>((resolve, reject) => 
    {
        if (!shouldHost) 
        {
            resolve();

            return;
        };

        console.log("Hosting project at %s", location.Directory);

        const host = spawn(`iisexpress`, [`/path:${location.Directory}`, `/port:${port}`], processConfig);

        host.stderr.on("data", (error) => 
        {
            process.stderr.write(error);

            process.exit();
        });

        host.stdout.on("data", (data:string) => 
        {
            if(data.indexOf("IIS Express is running.") > -1)
            {
                resolve();
            }
            
            if(data.indexOf("Enter 'Q' to stop IIS Express") === -1)
            {
                process.stdout.write(data);
            }
        });

        host.on("exit", () => 
        {
            process.exit();
        });

        process.on("exit", () => 
        {
            try 
            {
                host.stdin.write("q", "utf8");
                host.kill("SIGINT");
            }
            catch (e) 
            {
                
            }
        });
    });
};

const finchForward = () => 
{
    return new BBPromise<void>((resolve, reject) => 
    {
        if (!shouldHost || !finchName) 
        {
            resolve();

            return;
        }

        console.log(`Forwarding port ${port} to Finch site ${finchName}`);

        const forward = spawn(`finch`, ["forward", `--name`, `${finchName}`], processConfig);

        forward.stdout.on("data", (data) => 
        {
            if (data.indexOf("one or more subdomains are currently in use") > -1) 
            {
                console.log("Finch host still in use, skipping startup.");
                console.log("Note: Finch host may be killed at any time, command line is unable to force restart.");
                console.log("Enter 'Q' to stop IIS Express");
                
                return;
            }
            
            process.stdout.write(data);
        });

        forward.on("exit", () => 
        {
            resolve();
        });

        process.on("exit", () => 
        {
            try 
            {
                //Send CTRL+C to Finch command line to cancel forward.
                (<any> forward.stdin["write"])(null, {control: true, name: "c"});
                forward.kill("SIGINT");
            }
            catch (e) 
            {
                //Swallow
                if(e.code !== "EPIPE")
                {
                    console.log("Could not stop Finch.", e);
                };
            }
        });
    });
};

//Always restore packages first, because a build will fail without its packages
findStartupProjectPath().then(restorePackages).then(executeBuild).then(findStartupProjectPath).then(host).then(finchForward);
