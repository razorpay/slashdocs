package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	docs "github.com/razorpay/slashdocs/api/internal/server/docs"
)

func registerAPIDocsRoutes(r *gin.Engine, deps dependencies) {
	docs.SwaggerInfo.BasePath = "/"
	require := requireAuth(deps.authenticator, deps.appOrigin, deps.googleGroupResolver)
	apiDocs := r.Group("", require)
	apiDocs.GET("/api-docs", func(c *gin.Context) { c.Redirect(http.StatusFound, "/api-docs/index.html") })
	apiDocs.GET("/api-docs/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
	apiDocs.GET("/openapi.json", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json; charset=utf-8", []byte(docs.SwaggerInfo.ReadDoc()))
	})
}
