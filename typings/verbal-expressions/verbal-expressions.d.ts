declare module "verbal-expressions" 
{
    function V(): V.VarEx;

	module V 
    {
        interface VarEx 
        {
            startOfLine: () => VarEx;
            endOfLine: () => RegExp;
            then: (s: string) => VarEx;
            maybe: (s: string) => VarEx;
            anythingBut: (s: string) => VarEx;
            find: (s: string) => RegExp;
        }
	}

	export = V;
}
