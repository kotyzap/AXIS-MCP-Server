# No-op targets. TypeScript is prebuilt by tsc and the app "binary" is a shell
# launcher, but acap-build always runs `make`.
all:
	@true

clean:
	@true
