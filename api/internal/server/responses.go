package server

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

// errorBody is the payload of every error response.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// errorEnvelope wraps errorBody under the "error" key; all error responses
// share this shape.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

func notFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, errorResponse("not_found", "not found", nil))
}

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, errorResponse("bad_request", msg, nil))
}

func forbidden(c *gin.Context, msg string) {
	c.JSON(http.StatusForbidden, errorResponse("forbidden", msg, nil))
}

func featureDisabled(c *gin.Context, message string) {
	c.JSON(http.StatusNotFound, errorResponse("feature_disabled", message, nil))
}

// internalErr logs err (if non-nil) and writes a 500 response.
func internalErr(c *gin.Context, err error) {
	if err != nil {
		requestLogger(c).Error("internal error", slog.Any("error", err))
	} else {
		requestLogger(c).Error("internal error")
	}
	c.JSON(http.StatusInternalServerError, errorResponse("internal", "internal server error", nil))
}

func errorResponse(code, message string, details any) errorEnvelope {
	return errorEnvelope{Error: errorBody{Code: code, Message: message, Details: details}}
}
