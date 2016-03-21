#!/usr/bin/env node
/// <reference path="./typings/tsd.d.ts" />

import * as program from "commander";
import * as glob from "glob";
import * as fs from "fs";
import * as cp from "child_process";
import * as BBPromise from "bluebird";
import * as path from "path";
import * as parseXml from "xml-parser";
import {filter, find, some} from "lodash";
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

const port = program["port"] || 62211;
const shouldHost: boolean = program["iis"];
const finchName: string = program["finchName"];
const skipBuild: boolean = program["noBuild"];
const cwd = process.cwd();
const shouldRestore= program["restore"];
const newMigrationName: string = program["newMigration"];
const targetMigration: string = program["targetMigration"];
let solution: string = program["solution"];

declare type ProjectLocation = {File: string; Directory: string; AssemblyFile: string;};

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

export module F5
{
    export function start()
    {
        //Always restore packages first, because a build will fail without its packages
        findStartupProjectPath()
            .then(restorePackages)
            .then(executeBuild)
            .then(createMigration)
            .then(restoreMigration)
            .then(host)
            .then(finchForward);
    }
    
    const processConfig = 
    {
        cwd: cwd,
        env: process.env
    };
    
    const findAssembly = (location: ProjectLocation) => new BBPromise<string>((resolve, reject) =>
    {
        //Find the path to the assembly (.dll file)
        fs.readFile(location.File , { encoding: "utf8" }, (error, data) => 
        {
            const xml = parseXml(data);
            const propGroups = filter(xml.root.children, node => node.name === "PropertyGroup" && some(node.children, child => child.name === "AssemblyName"));
            const assemblyName = find(propGroups[0].children, node => node.name === "AssemblyName");
            
            resolve(path.join(location.Directory, "bin", assemblyName.content + ".dll"));
        });
    });
    
    const findStartupProjectPath = () =>new BBPromise<ProjectLocation>((resolve, reject) => 
    {            
        if(solution.indexOf(".csproj") > -1)
        {
            let output: ProjectLocation = {
                Directory: path.parse(solution).dir,
                File: solution,
                AssemblyFile: undefined
            }
            
            findAssembly(output).then((assemblyFile) =>
            {
                output.AssemblyFile = assemblyFile;
                
                resolve(output); 
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

            let output: ProjectLocation = {
                Directory: projectDirectory,
                AssemblyFile: undefined,
                File: projectFile,
            }
            
            findAssembly(output).then((assemblyFile) =>
            {
                output.AssemblyFile = assemblyFile;
                
                resolve(output); 
            });
            
            resolve(output);
        });
    });
    
    const executeBuild = (location: ProjectLocation) => new BBPromise<ProjectLocation>((resolve, reject) => 
    {
        if(skipBuild)
        {
            resolve(location);
            
            return;
        }
        
        const build = cp.exec(`msbuild "${location.File}" /verbosity:m`, processConfig, (error) => 
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
            resolve(location);
        });

        process.on("exit", () => 
        {
            try 
            {
                build.kill();
            }
            catch (e) 
            {
                //Swallow
            }
        });
    });

    const createMigration = (location: ProjectLocation) =>  new BBPromise<ProjectLocation>((resolve, reject) =>
    {
        if (!newMigrationName)
        {
            resolve(location);
            
            return;
        }
        
        console.log("Creating target migration.", newMigrationName);
        
        const replaceSplashes = (str: string) =>
        {
            while (str.indexOf("\\") > -1)
            {
                str = str.replace("\\", "/");
            }
            
            return str;
        }
        
        const webConfigPath = path.join(location.Directory, "web.config");
        const exePath = path.join(__dirname, "/bin/EntityFramework.6.1.3/tools/migrate.exe");
        const command = replaceSplashes(`${exePath} "${location.AssemblyFile}" /startupConfigurationFile="${webConfigPath}"`);
        
        console.log("Migration command: ", command);
        
        const migrate = cp.exec(command);
        
        migrate.stderr.on("data", (error) => 
        {
            process.stderr.write(error);
        })

        migrate.stdout.on("data", (data) => 
        {
            process.stdout.write(data);
        })

        migrate.on("exit", () => 
        {
            resolve(location);
        });

        process.on("exit", () => 
        {
            try 
            {
                migrate.kill();
            }
            catch (e) 
            {
                //Swallow
            }
        });
        
        resolve(location);
    });
    
    const restoreMigration =(location: ProjectLocation) => new BBPromise<ProjectLocation>((resolve, reject) =>
    {
        if (!targetMigration)
        {
            resolve(location);
            
            return; 
        }
    });

    const restorePackages = (location: ProjectLocation) => new BBPromise<ProjectLocation>((resolve, reject) =>
    {
        if(!shouldRestore)
        {
            resolve(location);
            
            return;
        }
        
        //Assume there's a packages.config file in the project file's directory, and 
        //that packages directory is one level above .csproj directory.
        const packagesDirectory = path.join(location.Directory, "../packages");
        const configFile = path.join(location.Directory, "packages.config"); 
        
        console.log("Restoring packages to %s", packagesDirectory);
        
        const restore = cp.exec(`nuget restore -outputdirectory "${packagesDirectory}" -configfile "${configFile}"`, processConfig, (error) =>
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
            resolve(location);
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

    const host = (location: ProjectLocation) =>new BBPromise<void>((resolve, reject) => 
    {
        if (!shouldHost) 
        {
            resolve();

            return;
        };

        //IIS requires the path to use backslashes rather than forward slashes. Using backslashes 
        //will make IIS throw 404s on any requested URL.
        const directory = location.Directory.split("/").join("\\");
        
        console.log("Hosting project at %s", directory);

        const host = spawn(`iisexpress`, [`/path:${directory}`, `/port:${port}`], processConfig);

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

    const finchForward = () => new BBPromise<void>((resolve, reject) => 
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
                (forward.stdin["write"] as any)(null, {control: true, name: "c"});
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
}

F5.start();